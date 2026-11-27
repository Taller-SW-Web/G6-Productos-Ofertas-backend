import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { checkConfig, runChecks } from './qa-gateway-admin-h5.mjs';

test('validates required settings and rejects insecure origins and malformed SHA', () => {
  assert.equal(checkConfig({}).missing.length, 4);
  const result = checkConfig({
    G6_TAXONOMY_QA_GATEWAY_ORIGIN: 'http://example.test',
    G6_TAXONOMY_QA_EXPECTED_SHA: 'bad',
  });
  assert.deepEqual(result.errors, [
    'G6_TAXONOMY_QA_GATEWAY_ORIGIN_INVALID',
    'G6_TAXONOMY_QA_EXPECTED_SHA_INVALID',
  ]);
});
test('rejects invalid or identical credentials without returning their contents', () => {
  const result = checkConfig({
    JWS_GESTOR_COMERCIAL: 'invalid',
    JWS_SIN_PERMISOS: 'invalid',
  });
  assert.ok(result.errors.includes('IDENTIDADES_IGUALES'));
  assert.equal(JSON.stringify(result).includes('invalid'), false);
});
test('accepts structurally valid local configuration', () => {
  const result = checkConfig({
    G6_TAXONOMY_QA_GATEWAY_ORIGIN: 'https://example.test',
    G6_TAXONOMY_QA_EXPECTED_SHA: 'a'.repeat(40),
    JWS_GESTOR_COMERCIAL: 'a.b.c',
    JWS_SIN_PERMISOS: 'd.e.f',
  });
  assert.deepEqual(result, { missing: [], errors: [] });
});
test('run uses GET against health and the two sessions without exposing tokens', async () => {
  const server = createServer((req, res) => {
    assert.equal(req.method, 'GET');
    res.statusCode = req.url === '/health' || req.headers.authorization === 'Bearer a.b.c' ? 200 : 403;
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    const env = { G6_TAXONOMY_QA_GATEWAY_ORIGIN: 'https://example.test', G6_TAXONOMY_QA_EXPECTED_SHA: 'a'.repeat(40), JWS_GESTOR_COMERCIAL: 'a.b.c', JWS_SIN_PERMISOS: 'd.e.f' };
    const result = await runChecks(env, (url, options) => fetch(`http://127.0.0.1:${port}${new URL(url).pathname}`, options));
    assert.deepEqual(result.results.map((item) => item.status), [200, 200, 403]);
    assert.equal(JSON.stringify(result).includes('a.b.c'), false);
    assert.equal(result.deployed_sha, 'NOT_VERIFIED');
    await assert.rejects(runChecks({ ...env, G6_TAXONOMY_QA_GATEWAY_ORIGIN: 'http://example.test' }), /CONFIG_INVALID/);
    await assert.rejects(runChecks({ ...env, G6_TAXONOMY_QA_EXPECTED_SHA: 'bad' }), /CONFIG_INVALID/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
