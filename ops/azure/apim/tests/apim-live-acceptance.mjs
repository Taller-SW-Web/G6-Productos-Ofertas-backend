#!/usr/bin/env node
/**
 * Runner de aceptación APIM-T01..APIM-T08 (sin ejecución sin autorización).
 * Requiere APIM_E2E_AUTHORIZED=1 y todos los insumos obligatorios.
 * Separa EVIDENCE_PREPARED, NOT_RUN, BLOCKED_INFRA, NOT_VERIFIED, FAIL y PASS.
 */

import { execSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const CASE_IDS = [
  'APIM-T01',
  'APIM-T02',
  'APIM-T03',
  'APIM-T04',
  'APIM-T05',
  'APIM-T06',
  'APIM-T07',
  'APIM-T08',
];

const OPEN_WILDCARD_CIDRS = new Set(['0.0.0.0/0', '*', '::/0']);

export function sha256Text(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function validateAcaIngressEvidence(ingressEvidence, expected) {
  for (const reqField of ['subscriptionId', 'resourceGroup', 'environment', 'capturedAtUtc', 'sourceCommand', 'gatewayApp']) {
    assert.ok(ingressEvidence[reqField], `APIM-T05 evidencia CLI incompleta: falta ${reqField}`);
  }
  assert.ok(String(ingressEvidence.sourceCommand).startsWith('az '), 'APIM-T05 evidencia debe provenir de Azure CLI');
  const ageHours = (Date.now() - Date.parse(ingressEvidence.capturedAtUtc)) / 3600000;
  assert.ok(ageHours >= 0 && ageHours <= 24, 'APIM-T05 evidencia Azure CLI caducada (>24h)');
  assert.equal(ingressEvidence.subscriptionId, expected.subscriptionId, 'APIM-T05 subscriptionId no coincide');
  assert.equal(ingressEvidence.resourceGroup, expected.resourceGroup, 'APIM-T05 resourceGroup no coincide');
  assert.equal(ingressEvidence.environment, expected.environment, 'APIM-T05 evidencia de otro ambiente');

  const gwApp = ingressEvidence.gatewayApp;
  assert.equal(gwApp.resourceId, expected.gatewayResourceId, 'APIM-T05 gatewayApp.resourceId no coincide');
  if (gwApp.external === false) {
    assert.ok(ingressEvidence.acaEnvironment?.vnetConfiguration, 'APIM-T05 Modalidad A (external=false) requiere vnetConfiguration');
  } else if (gwApp.external === true) {
    const restrictions = gwApp.ipSecurityRestrictions || [];
    assert.ok(restrictions.length > 0, 'APIM-T05 Modalidad B (external=true) requiere ipSecurityRestrictions Allow-only');
    const actions = new Set(restrictions.map((r) => r.action));
    assert.ok(
      actions.size === 1 && actions.has('Allow'),
      'APIM-T05 ACA no permite mezclar Allow y Deny; ipSecurityRestrictions debe ser exclusivamente Allow',
    );
    const allowCidrs = restrictions.map((r) => r.ipAddressRange);
    assert.ok(
      allowCidrs.every((c) => c && !OPEN_WILDCARD_CIDRS.has(c)),
      'APIM-T05 ipSecurityRestrictions no admite CIDRs vacíos o abiertos (0.0.0.0/0, *, ::/0)',
    );
    assert.ok(
      allowCidrs.every((c) => expected.originCidrs.includes(c)),
      'APIM-T05 ipSecurityRestrictions contiene CIDRs fuera de APIM autorizado',
    );
  } else {
    assert.fail('APIM-T05 gatewayApp.external debe ser booleano explícito');
  }
  assert.equal(gwApp.directRoutesBlocked, true, 'APIM-T05 rutas directas alternativas no acreditadas como bloqueadas');
}

export function validateRollbackEvidence(rollback, expected) {
  for (const field of [
    'resourceId',
    'subscriptionId',
    'resourceGroup',
    'apiName',
    'revisionBefore',
    'alternativeRevision',
    'revisionAfterRollback',
    'previousState',
    'alternativeAuthorizedState',
    'previousPolicyHash',
    'appliedPolicyHash',
    'rollbackPolicyHash',
    'restorationResult',
    'postRollbackRoutesStatus',
    'timestamp',
    'environment',
    'operationalApproval',
    'privateConnectivityCheck',
    'postRollbackSmokeResult',
    'azSnapshots',
  ]) {
    assert.ok(rollback[field] !== undefined && rollback[field] !== '', `APIM-T08 falta campo obligatorio: ${field}`);
  }
  assert.equal(rollback.resourceId, expected.apimResourceId, 'APIM-T08 resourceId no coincide con APIM esperado');
  assert.equal(rollback.subscriptionId, expected.subscriptionId, 'APIM-T08 subscriptionId no coincide');
  assert.equal(rollback.resourceGroup, expected.resourceGroup, 'APIM-T08 resourceGroup no coincide');
  assert.equal(rollback.environment, expected.environment, 'APIM-T08 ambiente de rollback no coincide');
  assert.equal(rollback.rollbackPolicyHash, rollback.previousPolicyHash, 'APIM-T08 hash post-rollback no coincide con hash previo');
  assert.notEqual(rollback.appliedPolicyHash, rollback.previousPolicyHash, 'APIM-T08 no hubo estado alternativo real');
  assert.equal(rollback.restorationResult, 'RESTORED', 'APIM-T08 restorationResult debe ser RESTORED');
  assert.equal(rollback.privateConnectivityCheck, 'PASS', 'APIM-T08 conectividad privada debe ser PASS');
  assert.equal(rollback.postRollbackSmokeResult, 'PASS', 'APIM-T08 smoke post-rollback debe ser PASS');

  const snaps = rollback.azSnapshots;
  for (const [phase, expectedHash, expectedRev] of [
    ['before', rollback.previousPolicyHash, rollback.revisionBefore],
    ['during', rollback.appliedPolicyHash, rollback.alternativeRevision],
    ['after', rollback.rollbackPolicyHash, rollback.revisionAfterRollback],
  ]) {
    const snap = snaps[phase];
    assert.ok(snap && typeof snap === 'object', `APIM-T08 falta azSnapshots.${phase}`);
    const cmd = String(snap.sourceCommand || '').trim();
    const isAllowedAzCmd =
      cmd.startsWith('az apim ') ||
      (cmd.startsWith('az rest ') && /\s--method\s+get\b/i.test(cmd) && cmd.includes('management.azure.com'));
    assert.ok(isAllowedAzCmd, `APIM-T08 azSnapshots.${phase}.sourceCommand debe ser az apim o az rest --method get`);
    assert.equal(snap.resourceId, expected.apimResourceId, `APIM-T08 azSnapshots.${phase}.resourceId no coincide`);
    assert.equal(snap.subscriptionId, expected.subscriptionId, `APIM-T08 azSnapshots.${phase}.subscriptionId no coincide`);
    assert.equal(snap.resourceGroup, expected.resourceGroup, `APIM-T08 azSnapshots.${phase}.resourceGroup no coincide`);
    assert.equal(snap.apiName, rollback.apiName, `APIM-T08 azSnapshots.${phase}.apiName no coincide`);
    assert.equal(snap.revision, expectedRev, `APIM-T08 azSnapshots.${phase}.revision no coincide`);
    assert.ok(typeof snap.policyXml === 'string' && snap.policyXml.includes('<policies>'), `APIM-T08 azSnapshots.${phase}.policyXml inválido`);
    const computedHash = sha256Text(snap.policyXml);
    assert.equal(computedHash, expectedHash, `APIM-T08 SHA256 real de policyXml en ${phase} no coincide con ${expectedHash}`);
    assert.equal(snap.policyHash, computedHash, `APIM-T08 azSnapshots.${phase}.policyHash declarado difiere del XML real`);
    assert.ok(snap.capturedAtUtc, `APIM-T08 azSnapshots.${phase} sin capturedAtUtc`);
  }
  assert.ok(
    Date.parse(snaps.before.capturedAtUtc) < Date.parse(snaps.during.capturedAtUtc) &&
      Date.parse(snaps.during.capturedAtUtc) < Date.parse(snaps.after.capturedAtUtc),
    'APIM-T08 secuencia temporal before < during < after inválida',
  );

  // R10 P1: validateRollbackEvidence() solo valida integridad local y devuelve EVIDENCE_PREPARED.
  // Ningún booleano ni digest dentro del mismo JSON acredita adquisición real en Azure.
  return {
    status: 'EVIDENCE_PREPARED',
    verified: false,
  };
}

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`MISSING_REQUIRED_INPUT: ${name}`);
  }
  return value;
}

function readJsonStrict(path, label) {
  assert.ok(existsSync(path), `${label}: archivo inexistente (${path})`);
  const raw = readFileSync(path, 'utf8').trim();
  assert.ok(raw.length > 0, `${label}: archivo vacío (${path})`);
  return JSON.parse(raw);
}

const INTERNAL_PATHS = [
  '/productos/skus/SKU-TEST/contexto',
  '/productos/skus/contexto/lote',
  '/interno/productos/skus/filtrar',
  `/interno/inventario/reservas/${randomUUID()}/evidencia-cupon`,
  `/interno/carga-masiva/contenidos/${randomUUID()}`,
];

export async function main() {
  if (process.env.APIM_E2E_AUTHORIZED !== '1') {
    const blocked = Object.fromEntries(CASE_IDS.map((id) => [id, 'NOT_RUN']));
    console.error(
      JSON.stringify({
        overall: 'BLOCKED_INFRA',
        reason: 'APIM_E2E_AUTHORIZED=1 requerido para ejecutar pruebas contra APIM real.',
        cases: blocked,
      }),
    );
    process.exit(2);
  }

  const baseUrl = requireEnv('APIM_BASE_URL');
  if (!baseUrl.startsWith('https://')) {
    throw new Error('APIM_BASE_URL debe usar HTTPS');
  }

  const protectedPath = process.env.APIM_TEST_PROTECTED_PATH?.trim() || '/productos';
  const expectedOwner = requireEnv('APIM_EXPECTED_OWNER');
  const expectedOperationId = requireEnv('APIM_EXPECTED_OPERATION_ID');
  const expectedEnvironment = requireEnv('APIM_EXPECTED_ENVIRONMENT');
  const expectedSubscriptionId = requireEnv('APIM_EXPECTED_SUBSCRIPTION_ID');
  const expectedResourceGroup = requireEnv('APIM_EXPECTED_RESOURCE_GROUP');
  const expectedGatewayResourceId = requireEnv('APIM_EXPECTED_GATEWAY_RESOURCE_ID');
  const expectedApimResourceId = requireEnv('APIM_EXPECTED_APIM_RESOURCE_ID');
  const expectedRegion = requireEnv('APIM_EXPECTED_REGION');
  const expectedRevision = requireEnv('APIM_EXPECTED_REVISION');
  const expectedPolicyHash = requireEnv('APIM_EXPECTED_POLICY_HASH');
  const expectedOperationSetSha256 = requireEnv('APIM_OPERATION_SET_SHA256');
  const expectedFilteredOpenApiSha256 = requireEnv('APIM_FILTERED_OPENAPI_SHA256');
  const expectedOriginCidrs = requireEnv('APIM_EXPECTED_ORIGIN_CIDRS')
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);
  const validM2mJwt = requireEnv('APIM_TEST_M2M_JWT');
  const validHumanJwt = requireEnv('APIM_TEST_HUMAN_JWT');
  const expiredJwt = requireEnv('APIM_TEST_EXPIRED_JWT');
  const wrongIssuerJwt = requireEnv('APIM_TEST_WRONG_ISSUER_JWT');
  const wrongAudienceJwt = requireEnv('APIM_TEST_WRONG_AUDIENCE_JWT');
  const badScopeJwt = requireEnv('APIM_TEST_BAD_SCOPE_JWT');
  const badRoleJwt = requireEnv('APIM_TEST_BAD_ROLE_JWT');
  const badClientJwt = requireEnv('APIM_TEST_BAD_CLIENT_JWT');
  const allowedOrigin = requireEnv('APIM_TEST_ALLOWED_ORIGIN');
  const directGatewayUrl = requireEnv('APIM_TEST_DIRECT_GATEWAY_URL');
  const ingressEvidencePath = requireEnv('APIM_INGRESS_EVIDENCE_PATH');
  const k6SummaryPath = requireEnv('APIM_K6_SUMMARY_PATH');
  const correlationTracePath = requireEnv('APIM_CORRELATION_TRACE_PATH');
  const traceQueryCmd = process.env.APIM_TRACE_QUERY_CMD?.trim() || '';
  const tracePropagationMs = Number(process.env.APIM_TRACE_PROPAGATION_MS || '2500');
  const rollbackEvidencePath = requireEnv('APIM_ROLLBACK_EVIDENCE_PATH');

  async function queryTracesAfterRequest(startIso) {
    await new Promise((r) => setTimeout(r, tracePropagationMs));
    if (traceQueryCmd) {
      execSync(traceQueryCmd, { stdio: 'inherit', timeout: 30_000 });
    }
    const traces = readJsonStrict(correlationTracePath, 'APIM_CORRELATION_TRACE_PATH');
    assert.ok(Array.isArray(traces), 'APIM_CORRELATION_TRACE_PATH debe ser un arreglo de trazas');
    return traces.filter((tr) => tr.timestamp && Date.parse(tr.timestamp) >= Date.parse(startIso));
  }

  const statusByCase = Object.fromEntries(CASE_IDS.map((id) => [id, 'NOT_RUN']));

  try {
    // APIM-T01
    const t01Corr = randomUUID();
    const t01Start = new Date().toISOString();
    const t01 = await fetch(`${baseUrl}${protectedPath}`, {
      headers: { Authorization: `Bearer ${validM2mJwt}`, 'X-Correlation-Id': t01Corr },
    });
    assert.equal(t01.status, 200, `APIM-T01 esperado 200, recibido ${t01.status}`);
    assert.equal(t01.headers.get('x-correlation-id'), t01Corr);
    const t01WindowTraces = await queryTracesAfterRequest(t01Start);
    const t01Trace = t01WindowTraces.find((tr) => tr.correlationId === t01Corr);
    assert.ok(t01Trace, 'NO_TELEMETRY_ARRIVED: APIM-T01 sin traza posterior para correlationId');
    assert.equal(t01Trace.operationId, expectedOperationId, 'APIM-T01 operationId no coincide');
    assert.equal(t01Trace.owner, expectedOwner, 'APIM-T01 owner alcanzado no coincide');
    assert.equal(t01Trace.environment, expectedEnvironment, 'APIM-T01 ambiente no coincide');
    statusByCase['APIM-T01'] = 'PASS';

    // APIM-T02
    for (const [label, authHeader] of [
      ['ausente', undefined],
      ['malformado', 'Bearer invalid.jwt.token'],
      ['expirado', `Bearer ${expiredJwt}`],
      ['issuer_incorrecto', `Bearer ${wrongIssuerJwt}`],
      ['audience_incorrecta', `Bearer ${wrongAudienceJwt}`],
    ]) {
      const res = await fetch(`${baseUrl}${protectedPath}`, {
        headers: authHeader ? { Authorization: authHeader } : {},
      });
      assert.equal(res.status, 401, `APIM-T02 (${label}) debe responder 401, recibido ${res.status}`);
    }
    const t02Human = await fetch(`${baseUrl}/productos/administracion`, {
      headers: { Authorization: `Bearer ${validHumanJwt}` },
    });
    assert.equal(t02Human.status, 200, 'APIM-T02 humano válido debe responder 200');
    statusByCase['APIM-T02'] = 'PASS';

    // APIM-T03
    const t03Start = new Date().toISOString();
    const t03Corrs = [randomUUID(), randomUUID(), randomUUID()];
    for (const [idx, [urlPath, jwt]] of [
      [protectedPath, badScopeJwt],
      ['/productos/administracion', badRoleJwt],
      [protectedPath, badClientJwt],
    ].entries()) {
      const res = await fetch(`${baseUrl}${urlPath}`, {
        headers: { Authorization: `Bearer ${jwt}`, 'X-Correlation-Id': t03Corrs[idx] },
      });
      assert.equal(res.status, 403, `APIM-T03 caso ${idx} debe responder 403`);
    }
    const t03WindowTraces = await queryTracesAfterRequest(t03Start);
    for (const corr of t03Corrs) {
      const edgeReject = t03WindowTraces.find(
        (tr) => tr.correlationId === corr && tr.status === 403 && tr.apimSeen === true,
      );
      assert.ok(edgeReject, `APIM-T03 falta traza explícita de rechazo 403 en APIM para ${corr}`);
      const providerHit = t03WindowTraces.find(
        (tr) => tr.correlationId === corr && tr.providerReached === true,
      );
      assert.equal(providerHit, undefined, `APIM-T03 rechazo 403 alcanzó el provider (${corr})`);
    }
    statusByCase['APIM-T03'] = 'PASS';

    // APIM-T04
    const t04Allow = await fetch(`${baseUrl}${protectedPath}`, {
      method: 'OPTIONS',
      headers: { Origin: allowedOrigin, 'Access-Control-Request-Method': 'GET' },
    });
    assert.equal(t04Allow.headers.get('access-control-allow-origin'), allowedOrigin);
    const t04Deny = await fetch(`${baseUrl}${protectedPath}`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://untrusted.invalid.example', 'Access-Control-Request-Method': 'GET' },
    });
    assert.equal(t04Deny.headers.get('access-control-allow-origin'), null);
    statusByCase['APIM-T04'] = 'PASS';

    // APIM-T05
    const ingressEvidence = readJsonStrict(ingressEvidencePath, 'APIM_INGRESS_EVIDENCE_PATH');
    validateAcaIngressEvidence(ingressEvidence, {
      subscriptionId: expectedSubscriptionId,
      resourceGroup: expectedResourceGroup,
      environment: expectedEnvironment,
      gatewayResourceId: expectedGatewayResourceId,
      originCidrs: expectedOriginCidrs,
    });

    const k6Summary = readJsonStrict(k6SummaryPath, 'APIM_K6_SUMMARY_PATH');
    if (k6Summary.verificationStatus !== 'VERIFIED') {
      statusByCase['APIM-T05'] = 'NOT_VERIFIED';
      throw new Error(`APIM-T05 k6 verificationStatus=${k6Summary.verificationStatus}`);
    }
    assert.equal(k6Summary.causes?.quota_burst_collision_429, 0, 'APIM-T05 k6 tuvo colisión cuota/burst');
    assert.equal(k6Summary.causes?.authz_false_positive, 0, 'APIM-T05 k6 tuvo falsos positivos de autorización');
    assert.ok((k6Summary.metrics?.burst429?.count ?? 0) > 0, 'APIM-T05 falta evidencia k6 de 429 burst');
    assert.ok((k6Summary.metrics?.burstRetryAfter?.count ?? 0) > 0, 'APIM-T05 falta evidencia k6 de Retry-After');
    assert.ok((k6Summary.metrics?.recovery200?.count ?? 0) > 0, 'APIM-T05 falta evidencia k6 de recuperación 200');
    assert.ok((k6Summary.metrics?.quota403?.count ?? 0) > 0, 'APIM-T05 falta evidencia k6 de cuota 403');
    assert.ok((k6Summary.metrics?.concurrency429?.count ?? 0) > 0, 'APIM-T05 falta evidencia k6 de concurrencia 429');
    assert.ok((k6Summary.metrics?.clientB200?.count ?? 0) > 0, 'APIM-T05 falta evidencia k6 de cliente B');
    assert.equal(k6Summary.metrics?.clientBFailed?.rate ?? 1, 0, 'APIM-T05 cliente B aislado tuvo fallos');
    assert.equal(k6Summary.metadata?.region, expectedRegion, 'APIM-T05 región k6 no coincide');
    assert.equal(k6Summary.metadata?.revision, expectedRevision, 'APIM-T05 revisión k6 no coincide');
    assert.equal(k6Summary.metadata?.policyHash, expectedPolicyHash, 'APIM-T05 policyHash k6 no coincide');
    assert.equal(k6Summary.metadata?.operationSetSha256, expectedOperationSetSha256, 'APIM-T05 operationSetSha256 k6 no coincide');
    assert.equal(k6Summary.metadata?.filteredOpenApiCanonicalSha256, expectedFilteredOpenApiSha256, 'APIM-T05 filteredOpenApiCanonicalSha256 k6 no coincide');

    for (const directPath of [`/api/v1${protectedPath}`, '/health']) {
      let directHttpStatus = null;
      let directNetworkOutcome = 'NONE';
      try {
        const directRes = await fetch(`${directGatewayUrl}${directPath}`, {
          headers: { Authorization: `Bearer ${validM2mJwt}` },
          signal: AbortSignal.timeout(4000),
        });
        directHttpStatus = directRes.status;
      } catch (err) {
        directNetworkOutcome = err?.name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK_REJECTED';
      }
      if (directHttpStatus !== null) {
        assert.notEqual(directHttpStatus, 200, `APIM-T05 FALLO ANTI-BYPASS en ${directPath}: respondió 200`);
        assert.ok(
          directHttpStatus === 403 && ingressEvidence.gatewayApp.originAccessPolicyApplied === true,
          `APIM-T05 status ${directHttpStatus} en ${directPath} sin política de origen acreditada`,
        );
      } else {
        assert.ok(['NETWORK_REJECTED', 'TIMEOUT'].includes(directNetworkOutcome));
      }
    }
    statusByCase['APIM-T05'] = 'PASS';

    // APIM-T06
    const unknownRes = await fetch(`${baseUrl}/ruta-desconocida-${randomUUID()}`, {
      headers: { Authorization: `Bearer ${validM2mJwt}` },
    });
    assert.equal(unknownRes.status, 404, 'APIM-T06 ruta desconocida debe responder 404');
    for (const internalPath of INTERNAL_PATHS) {
      const res = await fetch(`${baseUrl}${internalPath}`, {
        headers: { Authorization: `Bearer ${validM2mJwt}` },
      });
      assert.equal(res.status, 404, `APIM-T06 ruta interna ${internalPath} debe responder 404`);
    }
    statusByCase['APIM-T06'] = 'PASS';

    // APIM-T07
    assert.ok(
      t01Trace.apimSeen === true && t01Trace.gatewaySeen === true && t01Trace.providerSeen === true,
      'APIM-T07 correlación debe acreditarse en APIM, Gateway y provider',
    );
    const t07Bad = await fetch(`${baseUrl}${protectedPath}`, {
      headers: { Authorization: `Bearer ${validM2mJwt}`, 'X-Correlation-Id': `{${randomUUID()}}` },
    });
    assert.equal(t07Bad.status, 400, 'APIM-T07 UUID no canónico debe responder 400');
    statusByCase['APIM-T07'] = 'PASS';

    // APIM-T08: integridad local + consulta independiente real del runner en Azure (nunca booleano del JSON)
    const rollback = readJsonStrict(rollbackEvidencePath, 'APIM_ROLLBACK_EVIDENCE_PATH');
    validateRollbackEvidence(rollback, {
      apimResourceId: expectedApimResourceId,
      subscriptionId: expectedSubscriptionId,
      resourceGroup: expectedResourceGroup,
      environment: expectedEnvironment,
    });
    const livePolicyXml = execSync(
      `az rest --method get --url "https://management.azure.com${expectedApimResourceId}/apis/${rollback.apiName}/policies/policy?api-version=2022-08-01&format=rawxml" --query properties.value -o tsv`,
      { encoding: 'utf8', timeout: 30_000 },
    ).trim();
    assert.ok(livePolicyXml.includes('<policies>'), 'APIM-T08 consulta az rest no devolvió XML de política válido');
    assert.equal(
      sha256Text(livePolicyXml),
      rollback.rollbackPolicyHash,
      'APIM-T08 hash real consultado en Azure difiere de rollbackPolicyHash',
    );
    statusByCase['APIM-T08'] = 'PASS';

    assert.ok(CASE_IDS.every((id) => statusByCase[id] === 'PASS'));
    console.log(JSON.stringify({ overall: 'PASS', cases: statusByCase }));
  } catch (err) {
    const failedCase = Object.keys(statusByCase).find((id) => statusByCase[id] === 'NOT_RUN');
    if (failedCase) statusByCase[failedCase] = 'FAIL';
    console.error(
      JSON.stringify({
        overall: 'FAIL',
        error: err instanceof Error ? err.message : String(err),
        cases: statusByCase,
      }),
    );
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('apim-live-acceptance.mjs')) {
  await main();
}
