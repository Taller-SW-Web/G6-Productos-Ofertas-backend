#!/usr/bin/env node
/**
 * Runner de aceptación APIM-T01..APIM-T08 (sin ejecución sin autorización).
 * Requiere APIM_E2E_AUTHORIZED=1 y todos los insumos obligatorios.
 * Separa PASS, FAIL, NOT_RUN y BLOCKED por caso; nunca declara PASS global si falta un caso.
 */

import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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

if (process.env.APIM_E2E_AUTHORIZED !== '1') {
  const blocked = Object.fromEntries(CASE_IDS.map((id) => [id, 'NOT_RUN']));
  console.error(
    JSON.stringify({
      overall: 'BLOCKED',
      reason: 'APIM_E2E_AUTHORIZED=1 requerido para ejecutar pruebas contra APIM real.',
      cases: blocked,
    }),
  );
  process.exit(2);
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

const baseUrl = requireEnv('APIM_BASE_URL');
if (!baseUrl.startsWith('https://')) {
  throw new Error('APIM_BASE_URL debe usar HTTPS');
}

const protectedPath = process.env.APIM_TEST_PROTECTED_PATH?.trim() || '/productos';
const expectedOwner = requireEnv('APIM_EXPECTED_OWNER');
const expectedOperationId = requireEnv('APIM_EXPECTED_OPERATION_ID');
const expectedEnvironment = requireEnv('APIM_EXPECTED_ENVIRONMENT');
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

const INTERNAL_PATHS = [
  '/productos/skus/SKU-TEST/contexto',
  '/productos/skus/contexto/lote',
  '/interno/productos/skus/filtrar',
  `/interno/inventario/reservas/${randomUUID()}/evidencia-cupon`,
  `/interno/carga-masiva/contenidos/${randomUUID()}`,
];

async function queryTracesAfterRequest(startIso) {
  await new Promise((r) => setTimeout(r, tracePropagationMs));
  if (traceQueryCmd) {
    execSync(traceQueryCmd, { stdio: 'inherit', timeout: 30_000 });
  }
  const traces = readJsonStrict(correlationTracePath, 'APIM_CORRELATION_TRACE_PATH');
  assert.ok(Array.isArray(traces), 'APIM_CORRELATION_TRACE_PATH debe ser un arreglo de trazas');
  return traces.filter((tr) => tr.timestamp && Date.parse(tr.timestamp) >= Date.parse(startIso));
}

async function run() {
  const statusByCase = Object.fromEntries(CASE_IDS.map((id) => [id, 'NOT_RUN']));

  try {
    // APIM-T01: HTTPS hacia operación autorizada + consulta posterior de telemetría
    const t01Corr = randomUUID();
    const t01Start = new Date().toISOString();
    const t01 = await fetch(`${baseUrl}${protectedPath}`, {
      headers: {
        Authorization: `Bearer ${validM2mJwt}`,
        'X-Correlation-Id': t01Corr,
      },
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

    // APIM-T02: JWT válido, ausente, malformado, expirado, issuer incorrecto, audience incorrecta
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
    assert.equal(t02Human.status, 200, `APIM-T02 humano válido debe responder 200`);
    statusByCase['APIM-T02'] = 'PASS';

    // APIM-T03: scope, rol y cliente incorrectos -> 403 con traza de rechazo y 0 hits en provider
    const t03Start = new Date().toISOString();
    const t03Corrs = [randomUUID(), randomUUID(), randomUUID()];
    for (const [idx, [urlPath, jwt]] of [
      [protectedPath, badScopeJwt],
      ['/productos/administracion', badRoleJwt],
      [protectedPath, badClientJwt],
    ].entries()) {
      const res = await fetch(`${baseUrl}${urlPath}`, {
        headers: {
          Authorization: `Bearer ${jwt}`,
          'X-Correlation-Id': t03Corrs[idx],
        },
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

    // APIM-T04: CORS positivo y negativo
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

    // APIM-T05: evidencia CLI Azure vigente + resultados k6 + prueba directa negativa multi-ruta
    const ingressEvidence = readJsonStrict(ingressEvidencePath, 'APIM_INGRESS_EVIDENCE_PATH');
    for (const reqField of ['subscriptionId', 'resourceGroup', 'environment', 'capturedAtUtc', 'sourceCommand', 'gatewayApp']) {
      assert.ok(ingressEvidence[reqField], `APIM-T05 evidencia CLI incompleta: falta ${reqField}`);
    }
    assert.ok(String(ingressEvidence.sourceCommand).startsWith('az '), 'APIM-T05 evidencia debe provenir de Azure CLI');
    const ageHours = (Date.now() - Date.parse(ingressEvidence.capturedAtUtc)) / 3600000;
    assert.ok(ageHours >= 0 && ageHours <= 24, 'APIM-T05 evidencia Azure CLI caducada (>24h)');
    assert.equal(ingressEvidence.environment, expectedEnvironment, 'APIM-T05 evidencia de otro ambiente');
    const gwApp = ingressEvidence.gatewayApp;
    const restrictions = gwApp.ipSecurityRestrictions || [];
    const hasApimOriginRule =
      gwApp.external === false ||
      (restrictions.some((r) => r.action === 'Allow' && r.ipAddressRange) &&
        restrictions.some((r) => r.action === 'Deny' && ['0.0.0.0/0', '*'].includes(r.ipAddressRange)));
    assert.ok(hasApimOriginRule, 'APIM-T05 falta restricción de origen APIM + denegación por defecto');
    assert.equal(gwApp.directRoutesBlocked, true, 'APIM-T05 rutas directas alternativas no acreditadas como bloqueadas');

    const k6Summary = readJsonStrict(k6SummaryPath, 'APIM_K6_SUMMARY_PATH');
    assert.ok((k6Summary.metrics?.burst429?.count ?? 0) > 0, 'APIM-T05 falta evidencia k6 de 429 burst');
    assert.ok((k6Summary.metrics?.quota403?.count ?? 0) > 0, 'APIM-T05 falta evidencia k6 de cuota 403');
    assert.ok((k6Summary.metrics?.concurrency429?.count ?? 0) > 0, 'APIM-T05 falta evidencia k6 de concurrencia 429');
    assert.equal(k6Summary.metrics?.authzFalsePositive?.count ?? 1, 0, 'APIM-T05 k6 tuvo falsos positivos de autorización');
    assert.equal(k6Summary.metrics?.clientBFailed?.rate ?? 1, 0, 'APIM-T05 cliente B aislado tuvo fallos');

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
          directHttpStatus === 403 && gwApp.originAccessPolicyApplied === true,
          `APIM-T05 status ${directHttpStatus} en ${directPath} sin política de origen acreditada`,
        );
      } else {
        assert.ok(['NETWORK_REJECTED', 'TIMEOUT'].includes(directNetworkOutcome));
      }
    }
    statusByCase['APIM-T05'] = 'PASS';

    // APIM-T06: ruta desconocida y 5 internas excluidas -> 404
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

    // APIM-T07: correlación cruzada APIM -> Gateway -> provider + rechazo UUID no canónico
    assert.ok(
      t01Trace.apimSeen === true && t01Trace.gatewaySeen === true && t01Trace.providerSeen === true,
      'APIM-T07 correlación debe acreditarse en APIM, Gateway y provider',
    );
    const t07Bad = await fetch(`${baseUrl}${protectedPath}`, {
      headers: {
        Authorization: `Bearer ${validM2mJwt}`,
        'X-Correlation-Id': `{${randomUUID()}}`,
      },
    });
    assert.equal(t07Bad.status, 400, 'APIM-T07 UUID no canónico debe responder 400');
    statusByCase['APIM-T07'] = 'PASS';

    // APIM-T08: esquema estructurado de evidencia de rollback
    const rollback = readJsonStrict(rollbackEvidencePath, 'APIM_ROLLBACK_EVIDENCE_PATH');
    for (const field of [
      'resourceId',
      'revisionBefore',
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
    ]) {
      assert.ok(rollback[field] !== undefined && rollback[field] !== '', `APIM-T08 falta campo obligatorio: ${field}`);
    }
    assert.equal(rollback.environment, expectedEnvironment, 'APIM-T08 ambiente de rollback no coincide');
    assert.equal(rollback.rollbackPolicyHash, rollback.previousPolicyHash, 'APIM-T08 hash post-rollback no coincide con hash previo');
    assert.notEqual(rollback.appliedPolicyHash, rollback.previousPolicyHash, 'APIM-T08 no hubo estado alternativo real');
    assert.equal(rollback.restorationResult, 'RESTORED', 'APIM-T08 restorationResult debe ser RESTORED');
    assert.equal(rollback.privateConnectivityCheck, 'PASS', 'APIM-T08 conectividad privada debe ser PASS');
    assert.equal(rollback.postRollbackSmokeResult, 'PASS', 'APIM-T08 smoke post-rollback debe ser PASS');
    statusByCase['APIM-T08'] = 'PASS';

    assert.ok(CASE_IDS.every((id) => statusByCase[id] === 'PASS'));
    console.log(JSON.stringify({ overall: 'PASS', cases: statusByCase }));
  } catch (err) {
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

await run();
