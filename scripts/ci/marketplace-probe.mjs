import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
const token = async path => (await (await fetch('https://issuer:3443/' + path)).json()).token;
const valid = await token('valid');
const expired = await token('expired');
const forbidden = await token('forbidden');
async function check(path, expected, bearer = valid, base = 'http://api-gateway:3000') {
  const correlation = randomUUID();
  const response = await fetch(base + path, { headers: { 'x-correlation-id': correlation, ...(bearer ? { authorization: 'Bearer ' + bearer } : {}) }, signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, expected, path);
  const payload = await response.json();
  if (base.includes('api-gateway')) assert.equal(response.headers.get('x-correlation-id'), correlation);
  if (expected >= 400) {
    assert.match(response.headers.get('content-type'), /application\/problem\+json/);
    assert.equal(payload.code, ({ 400: 'VALIDACION', 401: 'TOKEN_INVALIDO', 403: 'SCOPE_INSUFICIENTE', 503: 'SERVICIO_NO_DISPONIBLE' })[expected]);
  }
  return payload;
}
if (process.argv[2] === 'offline') {
  await check('/api/v1/categorias', 503);
  await check('/health', 200);
} else {
  assert.deepEqual((await check('/api/v1/categorias', 200)).categories, []);
  for (const path of ['/api/v1/categorias', '/api/v1/productos?canal=MARKETPLACE&q=ci', '/api/v1/productos/por-slug/inexistente?canal=MARKETPLACE']) {
    await check(path, 401, '');
    await check(path, 401, expired);
    await check(path, 403, forbidden);
  }
  await check('/api/v1/productos?canal=MARKETPLACE&q=ci', 503);
  await check('/api/v1/productos/por-slug/inexistente?canal=MARKETPLACE', 503);
  await check('/api/v1/productos?canal=MARKETPLACE&pagina=0', 400);
  await check('/health/ready', 200, '', 'http://taxonomy-svc:3006');
  await check('/health/ready', 503, '', 'http://catalog-svc:3001');
  await check('/health', 200, '', 'http://catalog-svc:3001');
}
console.log('PASS: Docker Marketplace ' + (process.argv[2] ?? 'online') + ' (sin elegibilidad comercial inventada)');
