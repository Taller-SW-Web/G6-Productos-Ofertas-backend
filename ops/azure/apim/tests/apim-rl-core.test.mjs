import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyHttpResponse,
  headerValue,
  matchesTemplatePath,
  parseRetryAfter,
  validateEffectiveOperation,
} from './apim-rl-core.mjs';

test('Retry-After accepts delta-seconds and HTTP-date, rejects missing, malformed, and excessive waits', () => {
  const now = Date.parse('2026-11-28T10:00:00Z');
  assert.deepEqual(parseRetryAfter('3', now, 10), { valid: true, seconds: 3 });
  assert.deepEqual(parseRetryAfter('Sat, 28 Nov 2026 10:00:05 GMT', now, 10), { valid: true, seconds: 5 });
  assert.deepEqual(parseRetryAfter(undefined, now, 10), { valid: false, reason: 'missing' });
  assert.deepEqual(parseRetryAfter('1.5', now, 10), { valid: false, reason: 'format' });
  assert.deepEqual(parseRetryAfter('11', now, 10), { valid: false, reason: 'limit' });
});

test('classification keeps raw HTTP meanings separate from expected rate limiting and quota', () => {
  assert.equal(classifyHttpResponse(200, '', {}), 'admitted');
  assert.equal(classifyHttpResponse(429, '', {}, { rateLimitEnabled: true }), 'rate_limited');
  assert.equal(classifyHttpResponse(429, '', {}), 'unexpected_429');
  assert.equal(classifyHttpResponse(403, '{"code":"RATE_LIMIT_CUOTA"}', {}, {
    quotaEnabled: true, quotaErrorCodes: ['RATE_LIMIT_CUOTA'],
  }), 'quota_exhausted');
  assert.equal(classifyHttpResponse(403, '{"code":"SCOPE_INSUFICIENTE"}', {}, {
    quotaEnabled: true, quotaErrorCodes: ['RATE_LIMIT_CUOTA'],
  }), 'authorization_insufficient');
  assert.equal(classifyHttpResponse(403, '{"status":403}', {}, { quotaEnabled: true }), 'unexpected_403');
  assert.equal(classifyHttpResponse(401, '', {}), 'authentication_invalid');
  assert.equal(classifyHttpResponse(503, '', {}), 'unexpected_5xx');
  assert.equal(classifyHttpResponse(0, '', {}), 'connection_error');
  assert.equal(headerValue({ 'Retry-After': '4' }, 'retry-after'), '4');
});

const manifest = {
  fixtureType: 'LOCAL_SIMULATION',
  publicationMode: 'effective',
  operationSetSha256: 'a'.repeat(64),
  filteredOpenApiCanonicalSha256: 'b'.repeat(64),
  effectivePublication: { authorized: true, publishedOperationIds: ['listarProductos'] },
  operations: [{
    operationId: 'listarProductos', method: 'GET', path: '/productos',
    rateProfile: 'commercial_read', environmentEnabled: true,
  }],
};
const parameters = {
  expectedOperationSetSha256: 'a'.repeat(64),
  expectedFilteredOpenApiSha256: 'b'.repeat(64),
  deploymentRevision: 'REV-LOCAL',
  policyHash: 'c'.repeat(64),
  rateProfiles: { commercial_read: { burstCalls: 3, burstWindowSeconds: 2 } },
};
const expected = {
  origin: 'http://127.0.0.1:5055', operationSetSha256: 'a'.repeat(64),
  filteredOpenApiSha256: 'b'.repeat(64), revision: 'REV-LOCAL', policyHash: 'c'.repeat(64),
  operationId: 'listarProductos', method: 'GET', path: '/productos', rateProfile: 'commercial_read',
  burstCalls: 3, burstWindowSeconds: 2, maxRequests: 5, maxAuthorizedRequests: 5,
  maxConcurrency: 3, authorizedConcurrency: 3, maxVus: 1, authorizedVus: 1, maxRps: 3, authorizedRps: 3,
  maxDurationSeconds: 10, maxRetryAfterSeconds: 5, authorizedDurationSeconds: 10,
};

test('la ruta efectiva solo se acepta cuando host, método, perfil, hashes y presupuesto coinciden', () => {
  const result = validateEffectiveOperation({
    baseUrl: 'http://127.0.0.1:5055/api/v1', manifest, parameters, expected,
  });
  assert.equal(result.operation.operationId, 'listarProductos');
  assert.equal(result.profile.burstCalls, 3);
  assert.equal(matchesTemplatePath('/productos/sku-1', '/productos/{sku}'), true);
  assert.equal(matchesTemplatePath('/productos', '/productos/{sku}'), false);
  assert.throws(() => validateEffectiveOperation({
    baseUrl: 'http://127.0.0.1:5055/api/v1', manifest, parameters, expected, remote: true,
  }), /HOST_NO_AUTORIZADO/);
  assert.throws(() => validateEffectiveOperation({
    baseUrl: 'http://127.0.0.1:5056/api/v1', manifest, parameters, expected,
  }), /HOST_NO_AUTORIZADO/);
  assert.throws(() => validateEffectiveOperation({
    baseUrl: 'http://127.0.0.1:5055/api/v1', manifest, parameters,
    expected: { ...expected, maxRequests: 6 },
  }), /PRESUPUESTO_SOLICITUDES_INVALIDO/);
  assert.throws(() => validateEffectiveOperation({
    baseUrl: 'http://127.0.0.1:5055/api/v1', manifest, parameters,
    expected: { ...expected, maxConcurrency: 4 },
  }), /CONCURRENCIA_NO_AUTORIZADA/);
});
