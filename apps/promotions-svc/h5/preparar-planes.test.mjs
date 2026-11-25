import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { prepararPlanes } from './preparar-planes.mjs';

const sha = (char) => char.repeat(40);
const digest = `sha256:${'a'.repeat(64)}`;
const scenarioFile = new URL('./escenarios.json', import.meta.url);
const escenarios = JSON.parse(await readFile(scenarioFile, 'utf8'));

test('PREPARED crea planes UUID estables aunque falten evidencias externas', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'g6-h5-prepared-'));
  const output = join(dir, 'plans');
  t.after(() => rm(dir, { recursive: true, force: true }));
  const result = await prepararPlanes({}, output, scenarioFile, 'prepare');
  assert.equal(result.phase, 'PREPARED');
  assert.equal(result.cases, 20);
  const manifest = JSON.parse(await readFile(result.manifest, 'utf8'));
  assert.equal(Object.keys(manifest).length, 20);
  const stableIds = new Map();
  for (const [id, entry] of Object.entries(manifest)) {
    const planPath = join(output, entry.plan);
    const plan = JSON.parse(await readFile(planPath, 'utf8'));
    assert.equal(plan.case_id, id);
    assert.equal(plan.authorization_status, 'PREPARED');
    assert.equal(plan.execute, false);
    assert.equal(entry.execute, false);
    assert.ok(plan.correlation_id);
    stableIds.set(id, {
      correlation_id: plan.correlation_id,
      operations: plan.operations,
    });
    assert.equal(plan.g5_sha, undefined);
    assert.equal(plan.g5_evidence, undefined);
  }
  await assert.rejects(prepararPlanes({}, output, scenarioFile, 'prepare'));
  assert.deepEqual(
    stableIds.get('G5-H5-04').operations,
    JSON.parse(await readFile(join(output, 'G5-H5-04.json'), 'utf8'))
      .operations,
  );
});

function authorizationProfile(plans, keyPair) {
  const cases = {};
  for (const scenario of escenarios) {
    const plan = plans.get(scenario.id);
    const id = scenario.id;
    const input = {
      ...(scenario.requires_order ? { order_id: `SYNTHETIC-${id}` } : {}),
      ...(scenario.requires_scenario
        ? {
            scenario: {
              sku: 'VALIDATED-SYNTHETIC-SKU',
              quantity: 1,
              channel_id: 'TEST-WEB',
              coupon_code: 'TEST-CODE',
              currency: 'PEN',
              location_id: randomUUID(),
            },
            customer_ref: randomUUID(),
          }
        : {}),
      ...(scenario.requires_snapshot
        ? {
            g5_snapshot_confirmed: true,
            effective_at: '2026-11-21T16:00:00Z',
            customer_ref: randomUUID(),
          }
        : {}),
      ...(scenario.requires_g5_signature
        ? { effective_at: '2026-11-21T16:00:00Z' }
        : {}),
      ...([
        'G5-H5-03',
        'G5-H5-04',
        'G5-H5-05',
        'G5-H5-06',
        'G5-H5-10',
        'G5-H5-11',
      ].includes(scenario.id)
        ? { reservation_id: randomUUID() }
        : {}),
      ...(scenario.requires_existing_coupon
        ? { operations: { coupon: randomUUID() } }
        : {}),
      ...(scenario.requires_follow_operation
        ? { follow_type: 'cupones', follow_operation_id: randomUUID() }
        : {}),
      ...(scenario.id === 'G5-H5-13'
        ? {
            foreign_order_id: `SYNTHETIC-FOREIGN-${id}`,
            existing_coupon_operation_id: randomUUID(),
          }
        : {}),
      ...(scenario.id === 'G5-H5-06'
        ? { expected_restore_outcome: 'RESTORED' }
        : {}),
      ...(scenario.id === 'G5-H5-20'
        ? { message_ids: [randomUUID(), randomUUID()] }
        : {}),
      ...(scenario.id === 'G5-H5-02'
        ? { expected_reserve_status: 'REJECTED' }
        : {}),
      ...(scenario.requires_g5_signature ? {} : {}),
    };
    if (scenario.requires_g5_signature) {
      const reservationId = randomUUID();
      input.reservation_id = reservationId;
      input.operations = {
        ...(input.operations ?? {}),
        ...(scenario.id === 'G5-H5-03' || scenario.id === 'G5-H5-06'
          ? { coupon: randomUUID() }
          : {}),
      };
      const couponOperation =
        id === 'G5-H5-04' ? null : input.operations.coupon;
      const payload = Buffer.from(
        JSON.stringify({
          issuer: 'G5',
          event: id === 'G5-H5-03' ? 'PAGO_CONFIRMADO' : 'ANULACION_CONFIRMADA',
          event_id: `SIGNED-${id}`,
          occurred_at: '2026-11-22T16:00:00Z',
          environment: 'integration',
          gateway: 'https://gateway.integration.example.invalid',
          order_id: input.order_id,
          reservation_id: reservationId,
          coupon_operation_id: couponOperation,
          g5_sha: sha('2'),
          g6_sha: sha('1'),
        }),
      );
      input.g5_evidence = {
        payload: payload.toString('base64url'),
        signature: sign(null, payload, keyPair.privateKey).toString(
          'base64url',
        ),
      };
    }
    if (input.operations) {
      for (const [name, idValue] of Object.entries(plan.operations)) {
        if (input.operations[name] === undefined)
          input.operations[name] = idValue;
      }
      if (input.operations.coupon === undefined && plan.operations.coupon)
        input.operations.coupon = plan.operations.coupon;
    }
    if (scenario.requires_existing_coupon)
      input.operations = {
        ...(input.operations ?? {}),
        coupon: input.operations?.coupon ?? randomUUID(),
      };
    cases[id] = input;
  }
  return {
    environment: 'integration',
    gateway: 'https://gateway.integration.example.invalid',
    g6_sha: sha('1'),
    g5_sha: sha('2'),
    g6_destination: 'chile-shared',
    g6_cd_runs: Object.fromEntries(
      ['api-gateway', 'catalog-svc', 'inventory-svc', 'promotions-svc'].map(
        (name, index) => [name, 501 + index],
      ),
    ),
    g5_deployment: {
      verification_status: 'VERIFIED',
      commit_sha: sha('2'),
      image_digest: digest,
      revision: 'verified-synthetic-revision',
      evidence_url: 'https://evidence.example.invalid/g5-deployment',
      verified_at: '2026-11-22T17:00:00Z',
      verified_by: 'G5 test fixture',
    },
    cases,
  };
}

test('update es idempotente, no rota UUID y authorize nunca activa execute', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'g6-h5-update-'));
  const output = join(dir, 'plans');
  const keyPair = generateKeyPairSync('ed25519');
  const keyPath = join(dir, 'g5-public.pem');
  await writeFile(
    keyPath,
    keyPair.publicKey.export({ type: 'spki', format: 'pem' }),
  );
  const previous = process.env.G5_H5_G5_EVIDENCE_PUBLIC_KEY;
  process.env.G5_H5_G5_EVIDENCE_PUBLIC_KEY = keyPath;
  t.after(async () => {
    if (previous === undefined) delete process.env.G5_H5_G5_EVIDENCE_PUBLIC_KEY;
    else process.env.G5_H5_G5_EVIDENCE_PUBLIC_KEY = previous;
    await rm(dir, { recursive: true, force: true });
  });
  await prepararPlanes({}, output, scenarioFile, 'prepare');
  const manifest = JSON.parse(
    await readFile(join(output, 'manifiesto.azure.json'), 'utf8'),
  );
  const resultPath = join(output, 'resultado-anterior.json');
  await writeFile(resultPath, 'preserve-this-result\n');
  const before = new Map();
  for (const [id, entry] of Object.entries(manifest))
    before.set(
      id,
      JSON.parse(await readFile(join(output, entry.plan), 'utf8')),
    );
  const profile = authorizationProfile(before, keyPair);
  const updated = await prepararPlanes(profile, output, scenarioFile, 'update');
  assert.equal(updated.phase, 'PREPARED');
  await prepararPlanes(profile, output, scenarioFile, 'update');
  const afterUpdate = new Map();
  for (const [id, entry] of Object.entries(manifest)) {
    const plan = JSON.parse(await readFile(join(output, entry.plan), 'utf8'));
    afterUpdate.set(id, plan);
    assert.equal(plan.correlation_id, before.get(id).correlation_id, id);
    for (const [name, operation] of Object.entries(before.get(id).operations))
      assert.equal(plan.operations[name], operation, `${id}.${name}`);
    assert.equal(plan.execute, false);
  }
  await assert.rejects(
    prepararPlanes(
      {
        ...profile,
        cases: {
          ...profile.cases,
          'G5-H5-01': {
            ...profile.cases['G5-H5-01'],
            order_id: 'CONTRADICTORY-ORDER',
          },
        },
      },
      output,
      scenarioFile,
      'update',
    ),
    /CONTRADICTORY_PLAN_FIELD_order_id/,
  );
  await assert.rejects(
    prepararPlanes(
      {
        ...profile,
        cases: {
          ...profile.cases,
          'G5-H5-01': {
            ...profile.cases['G5-H5-01'],
            operations: {
              ...(profile.cases['G5-H5-01'].operations ?? {}),
              reserve: randomUUID(),
            },
          },
        },
      },
      output,
      scenarioFile,
      'update',
    ),
    /CONTRADICTORY_PLAN_FIELD_operations\.reserve/,
  );
  assert.equal(await readFile(resultPath, 'utf8'), 'preserve-this-result\n');
  const authorized = await prepararPlanes(
    profile,
    output,
    scenarioFile,
    'authorize',
    escenarios.map(({ id }) => id),
  );
  assert.equal(authorized.phase, 'AUTHORIZED');
  for (const [id, entry] of Object.entries(manifest)) {
    const plan = JSON.parse(await readFile(join(output, entry.plan), 'utf8'));
    assert.equal(plan.authorization_status, 'AUTHORIZED', id);
    assert.equal(plan.execute, false, id);
  }
  assert.equal(afterUpdate.get('G5-H5-04').cancel_mode, 'release-only');
  assert.equal(afterUpdate.get('G5-H5-06').cancel_mode, 'restore-consumption');
});

test('authorize rechaza falta de firma auténtica y pedidos reutilizados', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'g6-h5-authorize-block-'));
  const output = join(dir, 'plans');
  t.after(() => rm(dir, { recursive: true, force: true }));
  await prepararPlanes({}, output, scenarioFile, 'prepare');
  const manifest = JSON.parse(
    await readFile(join(output, 'manifiesto.azure.json'), 'utf8'),
  );
  const plans = new Map();
  for (const [id, entry] of Object.entries(manifest))
    plans.set(id, JSON.parse(await readFile(join(output, entry.plan), 'utf8')));
  await assert.rejects(
    prepararPlanes(
      authorizationProfile(plans, generateKeyPairSync('ed25519')),
      output,
      scenarioFile,
      'authorize',
      ['G5-H5-03'],
    ),
    /G5_SIGNED_BUSINESS_EVIDENCE_REQUIRED/,
  );
  const duplicate = authorizationProfile(plans, generateKeyPairSync('ed25519'));
  duplicate.cases['G5-H5-02'].order_id = duplicate.cases['G5-H5-01'].order_id;
  await assert.rejects(
    prepararPlanes(duplicate, output, scenarioFile, 'update'),
    /EACH_SCENARIO_REQUIRES_AN_ISOLATED_ORDER/,
  );
});
