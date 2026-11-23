import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { prepararPlanes } from './preparar-planes.mjs';

const sha = (char) => char.repeat(40);
const digest = `sha256:${'a'.repeat(64)}`;
function profile() {
  const cases = {};
  const keys = generateKeyPairSync('ed25519');
  for (let number = 1; number <= 20; number++) {
    const id = `G5-H5-${String(number).padStart(2, '0')}`;
    cases[id] = {
      order_id: `SYNTHETIC-LOCAL-${id}`,
      fixture_origin: 'unit-test-only',
      scenario: {
        sku: 'SYNTHETIC-SKU',
        quantity: 1,
        channel_id: 'SYNTHETIC-CHANNEL',
        coupon_code: 'SYNTHETIC-COUPON',
        currency: 'PEN',
        location_id: randomUUID(),
      },
      customer_ref: randomUUID(),
      effective_at: '2026-11-21T16:00:00Z',
      reservation_id: randomUUID(),
      g5_snapshot_confirmed: true,
      follow_type: 'cupones',
      follow_operation_id: randomUUID(),
      foreign_order_id: `SYNTHETIC-FOREIGN-${id}`,
      operations: { coupon: randomUUID() },
      expected_restore_outcome: 'RESTORED',
    };
    cases[id].operations.coupon = cases[id].follow_operation_id;
  }
  const result = {
    environment: 'integration',
    gateway: 'https://gateway.integration.example.invalid',
    g6_sha: sha('1'),
    g5_sha: sha('2'),
    g6_cd_runs: Object.fromEntries(
      ['api-gateway', 'catalog-svc', 'inventory-svc', 'promotions-svc'].map((name, index) => [name, 123 + index]),
    ),
    g5_deployment: {
      verification_status: 'VERIFIED',
      commit_sha: sha('2'),
      image_digest: digest,
      revision: 'synthetic-revision',
      evidence_url: 'https://evidence.example.invalid/g5-deployment',
      verified_at: '2026-11-21T16:00:00Z',
      verified_by: 'G5 test fixture',
    },
    cases,
  };
  for (const id of ['G5-H5-03', 'G5-H5-04', 'G5-H5-06']) {
    const input = cases[id];
    const payload = Buffer.from(JSON.stringify({
      issuer: 'G5',
      environment: 'integration',
      event: id === 'G5-H5-03' ? 'PAGO_CONFIRMADO' : 'ANULACION_CONFIRMADA',
      event_id: `UNIT-${id}`,
      occurred_at: input.effective_at,
      gateway: result.gateway,
      order_id: input.order_id,
      reservation_id: input.reservation_id,
      coupon_operation_id: id === 'G5-H5-04' ? null : input.operations.coupon,
      g5_sha: result.g5_sha,
      g6_sha: result.g6_sha,
    }));
    input.g5_evidence = {
      payload: payload.toString('base64url'),
      signature: sign(null, payload, keys.privateKey).toString('base64url'),
    };
  }
  return result;
}

test('prepara veinte planes aislados con UUID estables y sin credenciales', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'g6-h5-plans-'));
  const output = join(dir, 'plans');
  t.after(() => rm(dir, { recursive: true, force: true }));
  const result = await prepararPlanes(profile(), output, new URL('./escenarios.json', import.meta.url));
  assert.equal(result.cases, 20);
  const manifest = JSON.parse(await readFile(result.manifest, 'utf8'));
  assert.equal(Object.keys(manifest).length, 20);
  const orders = new Set();
  const operationIds = new Set();
  for (const [id, entry] of Object.entries(manifest)) {
    assert.equal(entry.execute, false);
    const plan = JSON.parse(await readFile(join(output, entry.plan), 'utf8'));
    assert.equal(plan.case_id, id);
    assert.equal(plan.execute, false);
    assert.ok(plan.correlation_id);
    if (plan.order_id) {
      assert.ok(!orders.has(plan.order_id), `order reused: ${id}`);
      orders.add(plan.order_id);
    }
    for (const operationId of Object.values(plan.operations)) {
      assert.match(operationId, /^[a-f0-9-]{36}$/i);
      assert.ok(!operationIds.has(operationId), `operation reused: ${id}`);
      operationIds.add(operationId);
    }
    assert.equal(JSON.stringify(plan).includes('G5_H5_VENTAS_JWT'), false);
  }
  await assert.rejects(
    prepararPlanes(profile(), output, new URL('./escenarios.json', import.meta.url)),
  );
});

test('exige pedidos únicos, revisión G5 verificada y firma real en casos que la requieren', async () => {
  const valid = profile();
  valid.cases['G5-H5-02'].order_id = valid.cases['G5-H5-01'].order_id;
  await assert.rejects(
    prepararPlanes(valid, join(tmpdir(), 'must-not-exist-duplicate-' + randomUUID()), new URL('./escenarios.json', import.meta.url)),
    /EACH_SCENARIO_REQUIRES_AN_ISOLATED_ORDER/,
  );
  const withoutSignature = profile();
  delete withoutSignature.cases['G5-H5-03'].g5_evidence;
  await assert.rejects(
    prepararPlanes(withoutSignature, join(tmpdir(), 'must-not-exist-signature-' + randomUUID()), new URL('./escenarios.json', import.meta.url)),
    /SIGNED_G5_EVIDENCE_REQUIRED_G5-H5-03/,
  );
  const unverified = profile();
  unverified.g5_deployment.verification_status = 'PENDING';
  await assert.rejects(
    prepararPlanes(unverified, join(tmpdir(), 'must-not-exist-g5-' + randomUUID()), new URL('./escenarios.json', import.meta.url)),
    /G5_DEPLOYMENT_EVIDENCE_REQUIRED/,
  );
});
