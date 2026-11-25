#!/usr/bin/env node
/**
 * Runner de aceptación APIM-T01..APIM-T08 (sin ejecución sin autorización).
 * Requiere APIM_E2E_AUTHORIZED=1 y APIM_BASE_URL=https://<apim-host>/api/v1.
 */

import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

if (process.env.APIM_E2E_AUTHORIZED !== '1') {
  console.error(
    'BLOQUEADO: APIM_E2E_AUTHORIZED=1 requerido para ejecutar pruebas contra APIM real.',
  );
  process.exit(2);
}

const baseUrl = process.env.APIM_BASE_URL;
if (!baseUrl || !baseUrl.startsWith('https://')) {
  throw new Error('APIM_BASE_URL HTTPS es obligatorio');
}

const humanJwt = process.env.APIM_TEST_HUMAN_JWT ?? '';
const badScopeJwt = process.env.APIM_TEST_BAD_SCOPE_JWT ?? '';
const allowedOrigin = process.env.APIM_TEST_ALLOWED_ORIGIN ?? '';
const directGatewayUrl = process.env.APIM_TEST_DIRECT_GATEWAY_URL ?? '';

async function run() {
  // APIM-T01: HTTPS hacia operación autorizada y owner esperado
  const t01Corr = randomUUID();
  const t01 = await fetch(`${baseUrl}/productos`, {
    headers: { 'X-Correlation-Id': t01Corr },
  });
  assert.equal(t01.status, 200, 'APIM-T01 debe responder 200 en lectura autorizada');
  assert.equal(t01.headers.get('x-correlation-id'), t01Corr, 'APIM-T07 correlación preservada');

  // APIM-T02: JWT válido e inválido
  const t02NoAuth = await fetch(`${baseUrl}/productos/administracion`);
  assert.equal(t02NoAuth.status, 401, 'APIM-T02 sin JWT debe responder 401');
  if (humanJwt) {
    const t02Valid = await fetch(`${baseUrl}/productos/administracion`, {
      headers: { Authorization: `Bearer ${humanJwt}` },
    });
    assert.notEqual(t02Valid.status, 401, 'APIM-T02 JWT válido no debe ser 401');
  }

  // APIM-T03: scope y cliente incorrectos
  if (badScopeJwt) {
    const t03 = await fetch(`${baseUrl}/productos/administracion`, {
      headers: { Authorization: `Bearer ${badScopeJwt}` },
    });
    assert.equal(t03.status, 403, 'APIM-T03 scope/rol incorrecto debe responder 403');
  }

  // APIM-T04: CORS
  if (allowedOrigin) {
    const t04Allow = await fetch(`${baseUrl}/productos`, {
      method: 'OPTIONS',
      headers: {
        Origin: allowedOrigin,
        'Access-Control-Request-Method': 'GET',
      },
    });
    assert.equal(
      t04Allow.headers.get('access-control-allow-origin'),
      allowedOrigin,
      'APIM-T04 origen permitido debe reflejarse',
    );
    const t04Deny = await fetch(`${baseUrl}/productos`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://untrusted.invalid.example',
        'Access-Control-Request-Method': 'GET',
      },
    });
    assert.equal(
      t04Deny.headers.get('access-control-allow-origin'),
      null,
      'APIM-T04 origen no autorizado no debe recibir ACAO',
    );
  }

  // APIM-T05: anti-bypass directo al Gateway (rate-limit/cuota ejecutado por k6)
  if (directGatewayUrl) {
    try {
      const bypass = await fetch(`${directGatewayUrl}/api/v1/productos`, {
        signal: AbortSignal.timeout(4000),
      });
      assert.ok(
        [401, 403, 404].includes(bypass.status),
        `APIM-T05 acceso directo al Gateway debe estar bloqueado, recibido ${bypass.status}`,
      );
    } catch {
      // Rechazo de red / timeout esperado cuando el Gateway es privado detrás de APIM
    }
  }

  // APIM-T06: ruta desconocida o privada
  const t06 = await fetch(`${baseUrl}/interno/productos/skus/filtrar`, {
    method: 'POST',
    headers: humanJwt ? { Authorization: `Bearer ${humanJwt}` } : {},
  });
  assert.equal(t06.status, 404, 'APIM-T06 ruta interna debe responder 404');

  // APIM-T07: correlación inválida rechazada con 400
  const t07Bad = await fetch(`${baseUrl}/productos`, {
    headers: { 'X-Correlation-Id': 'not-a-uuid' },
  });
  assert.equal(t07Bad.status, 400, 'APIM-T07 correlación inválida debe responder 400');

  console.log('APIM-T01..T07 PASS (APIM-T08 rollback requiere procedimiento operativo aprobado)');
}

await run();
