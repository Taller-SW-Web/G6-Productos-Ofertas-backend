#!/usr/bin/env node
/**
 * Runner de aceptación APIM-T01..APIM-T08 (sin ejecución sin autorización).
 * Requiere APIM_E2E_AUTHORIZED=1 y todos los insumos obligatorios.
 * Nunca declara PASS global si algún caso obligatorio falta, se omite o falla.
 */

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import assert from 'node:assert/strict';

if (process.env.APIM_E2E_AUTHORIZED !== '1') {
  console.error(
    'BLOCKED: APIM_E2E_AUTHORIZED=1 requerido para ejecutar pruebas contra APIM real.',
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

const baseUrl = requireEnv('APIM_BASE_URL');
if (!baseUrl.startsWith('https://')) {
  throw new Error('APIM_BASE_URL debe usar HTTPS');
}

const protectedPath = process.env.APIM_TEST_PROTECTED_PATH?.trim() || '/productos';
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
const rollbackEvidencePath = requireEnv('APIM_ROLLBACK_EVIDENCE_PATH');

const INTERNAL_PATHS = [
  '/productos/skus/SKU-TEST/contexto',
  '/productos/skus/contexto/lote',
  '/interno/productos/skus/filtrar',
  `/interno/inventario/reservas/${randomUUID()}/evidencia-cupon`,
  `/interno/carga-masiva/contenidos/${randomUUID()}`,
];

async function run() {
  const results = [];

  // APIM-T01: HTTPS hacia operación autorizada con JWT contractual correcto (no anónimo)
  const t01Corr = randomUUID();
  const t01 = await fetch(`${baseUrl}${protectedPath}`, {
    headers: {
      Authorization: `Bearer ${validM2mJwt}`,
      'X-Correlation-Id': t01Corr,
    },
  });
  assert.notEqual(t01.status, 401, 'APIM-T01 JWT válido no debe ser 401');
  assert.notEqual(t01.status, 403, 'APIM-T01 JWT válido no debe ser 403');
  assert.equal(t01.status, 200, `APIM-T01 esperado 200, recibido ${t01.status}`);
  assert.equal(t01.headers.get('x-correlation-id'), t01Corr);
  results.push('APIM-T01:PASS');

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
  assert.equal(t02Human.status, 200, `APIM-T02 humano válido debe responder 200, recibido ${t02Human.status}`);
  results.push('APIM-T02:PASS');

  // APIM-T03: scope, rol y cliente incorrectos -> 403
  const t03Scope = await fetch(`${baseUrl}${protectedPath}`, {
    headers: { Authorization: `Bearer ${badScopeJwt}` },
  });
  assert.equal(t03Scope.status, 403, `APIM-T03 scope incorrecto debe responder 403`);
  const t03Role = await fetch(`${baseUrl}/productos/administracion`, {
    headers: { Authorization: `Bearer ${badRoleJwt}` },
  });
  assert.equal(t03Role.status, 403, `APIM-T03 rol incorrecto debe responder 403`);
  const t03Client = await fetch(`${baseUrl}${protectedPath}`, {
    headers: { Authorization: `Bearer ${badClientJwt}` },
  });
  assert.equal(t03Client.status, 403, `APIM-T03 cliente incorrecto debe responder 403`);
  results.push('APIM-T03:PASS');

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
  results.push('APIM-T04:PASS');

  // APIM-T05: anti-bypass real con JWT autorizado directo al Gateway
  let directHttpStatus = null;
  let directNetworkOutcome = 'NONE';
  try {
    const directRes = await fetch(`${directGatewayUrl}/api/v1${protectedPath}`, {
      headers: { Authorization: `Bearer ${validM2mJwt}` },
      signal: AbortSignal.timeout(4000),
    });
    directHttpStatus = directRes.status;
  } catch (err) {
    directNetworkOutcome = err?.name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK_REJECTED';
  }
  if (directHttpStatus !== null) {
    assert.notEqual(
      directHttpStatus,
      200,
      'APIM-T05 FALLO ANTI-BYPASS: el Gateway directo respondió 200 con JWT autorizado',
    );
    assert.ok(
      [401, 403, 404].includes(directHttpStatus),
      `APIM-T05 acceso directo devolvió status inesperado ${directHttpStatus}`,
    );
  } else {
    assert.ok(
      directNetworkOutcome === 'NETWORK_REJECTED' || directNetworkOutcome === 'TIMEOUT',
      'APIM-T05 resultado de red no determinado',
    );
  }
  results.push('APIM-T05_ANTIBYPASS:PASS');

  // APIM-T06: ruta desconocida y las 5 internas excluidas -> 404
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
  results.push('APIM-T06:PASS');

  // APIM-T07: correlación preservada y rechazo 400 a UUID inválido/no canónico
  const t07Bad = await fetch(`${baseUrl}${protectedPath}`, {
    headers: {
      Authorization: `Bearer ${validM2mJwt}`,
      'X-Correlation-Id': `{${randomUUID()}}`,
    },
  });
  assert.equal(t07Bad.status, 400, 'APIM-T07 UUID no canónico debe responder 400');
  results.push('APIM-T07:PASS');

  // APIM-T08: evidencia de rollback aprobada presente
  assert.ok(
    existsSync(rollbackEvidencePath),
    `APIM-T08 falta evidencia operativa de rollback: ${rollbackEvidencePath}`,
  );
  results.push('APIM-T08:PASS');

  console.log(JSON.stringify({ status: 'PASS', cases: results }));
}

await run();
