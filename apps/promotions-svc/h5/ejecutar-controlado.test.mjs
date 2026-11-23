import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ejecutarPreflight } from './ejecutar-controlado.mjs';

const vars = ['G5_H5_AUTHORIZED_GATEWAY_ORIGIN', 'G5_H5_VENTAS_JWT'];
function assignEnv(name, value) {
  const previous = process.env[name];
  process.env[name] = value;
  return () => previous === undefined ? delete process.env[name] : process.env[name] = previous;
}

test('preflight queda BLOCKED para homologación y acepta solo GET y validación de cupón', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'g6-h5-preflight-'));
  const gateway = 'https://private-gateway.example.invalid';
  const restore = vars.map((name) => assignEnv(name, name.endsWith('ORIGIN') ? gateway : 'test.jwt.value'));
  t.after(async () => { restore.forEach((fn) => fn()); await rm(dir, { recursive: true, force: true }); });
  const plan = join(dir, 'plan.json');
  await writeFile(plan, JSON.stringify({
    environment: 'integration',
    gateway,
    scenario: { sku: 'SYNTHETIC-SKU', quantity: 1, channel_id: 'SYNTHETIC', coupon_code: 'SYNTHETIC', currency: 'PEN', location_id: randomUUID() },
    customer_ref: randomUUID(),
  }));
  const manifest = { 'G5-H5-01': { plan } };
  const safeOutput = join(dir, 'safe.json');
  const safe = await ejecutarPreflight(manifest, ['G5-H5-01'], safeOutput, () => ({
    status: 0,
    stdout: [
      { event: 'http', method: 'GET', route: '/inventario/disponibilidad', status: 200 },
      { event: 'http', method: 'POST', route: '/cupones/validar', status: 200 },
    ].map((event) => JSON.stringify(event)).join('\n'),
  }));
  assert.equal(safe.results[0].technical_status, 'PASS');
  assert.equal(safe.results[0].status, 'BLOCKED');
  assert.equal(JSON.parse(await readFile(safeOutput, 'utf8')).results[0].status, 'BLOCKED');

  const unsafeOutput = join(dir, 'unsafe.json');
  const unsafe = await ejecutarPreflight(manifest, ['G5-H5-01'], unsafeOutput, () => ({
    status: 0,
    stdout: JSON.stringify({ event: 'http', method: 'POST', route: '/cupones/consumos', status: 202 }),
  }));
  assert.equal(unsafe.results[0].technical_status, 'FAIL');
  assert.equal(unsafe.results[0].status, 'BLOCKED');
  assert.equal(unsafe.results[0].reason, 'PREFLIGHT_FAILED_OR_MUTATING_ROUTE');
});
