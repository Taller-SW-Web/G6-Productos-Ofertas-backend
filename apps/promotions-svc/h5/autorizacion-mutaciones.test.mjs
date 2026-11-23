import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { authorizeMutation, mutationPlanDigest } from './autorizacion-mutaciones.mjs';

test('solo admite autorización Ed25519 vigente y ligada al caso, operación y entorno', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'g6-h5-mutation-auth-'));
  const keyPair = generateKeyPairSync('ed25519');
  const keyPath = join(dir, 'approver.pem');
  await writeFile(keyPath, keyPair.publicKey.export({ type: 'spki', format: 'pem' }));
  const restore = new Map();
  const variables = {
    G5_H5_MUTATION_AUTHORIZATION_PUBLIC_KEY: keyPath,
    G5_H5_AUTHORIZED_GATEWAY_ORIGIN: 'https://gateway.example.invalid',
    G5_H5_MUTATIONS: 'integration-only',
  };
  for (const [name, value] of Object.entries(variables)) {
    restore.set(name, process.env[name]);
    process.env[name] = value;
  }
  t.after(async () => {
    for (const [name, value] of restore) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(dir, { recursive: true, force: true });
  });

  const plan = {
    case_id: 'G5-H5-01', environment: 'integration', gateway: variables.G5_H5_AUTHORIZED_GATEWAY_ORIGIN,
    g5_sha: '1'.repeat(40), g6_sha: '2'.repeat(40), order_id: 'SYNTHETIC-ORDER',
    correlation_id: randomUUID(), operations: { reserve: randomUUID() },
  };
  const buildAuthorization = (overrides = {}) => {
    const payload = {
      issuer: 'G6_H5_MUTATION_AUTHORIZATION', authorized_by: 'Synthetic authorized owner',
      case_id: plan.case_id, stage: 'reserve', execute: true, environment: plan.environment,
      gateway: plan.gateway, g5_sha: plan.g5_sha, g6_sha: plan.g6_sha, order_id: plan.order_id,
      correlation_id: plan.correlation_id, operation_id: plan.operations.reserve, reservation_id: null,
      restore_operation_id: null, plan_sha256: mutationPlanDigest(plan),
      window_approval_ref: 'https://evidence.example.invalid/window/123',
      fixture_authorization_ref: 'https://evidence.example.invalid/fixture/456',
      issued_at: new Date(Date.now() - 1000).toISOString(),
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      ...overrides,
    };
    const bytes = Buffer.from(JSON.stringify(payload));
    return { execute: true, document: { payload: bytes.toString('base64url'), signature: sign(null, bytes, keyPair.privateKey).toString('base64url') } };
  };

  assert.equal((await authorizeMutation({ stage: 'reserve', plan, authorization: buildAuthorization(), execute: true })).case_id, plan.case_id);
  for (const [changes, code] of [
    [{ payload: { ...buildAuthorization().document, signature: Buffer.alloc(64).toString('base64url') } }, 'SIGNED_MUTATION_AUTHORIZATION_INVALID'],
    [{ authorization: { ...buildAuthorization(), execute: false } }, 'MUTATION_CASE_NOT_ENABLED'],
    [{ overrides: { order_id: 'OTHER-ORDER' } }, 'SIGNED_MUTATION_AUTHORIZATION_MISMATCH'],
    [{ overrides: { fixture_authorization_ref: 'http://fixture.example.invalid/1' } }, 'SIGNED_MUTATION_AUTHORIZATION_MISMATCH'],
    [{ overrides: { expires_at: new Date(Date.now() - 1).toISOString() } }, 'SIGNED_MUTATION_AUTHORIZATION_MISMATCH'],
  ]) {
    const authorization = changes.authorization ?? buildAuthorization(changes.overrides ?? {});
    if (changes.payload) authorization.document = changes.payload;
    await assert.rejects(authorizeMutation({ stage: 'reserve', plan, authorization, execute: true }), new RegExp(code));
  }
  await assert.rejects(authorizeMutation({ stage: 'reserve', plan, authorization: buildAuthorization(), execute: false }), /MUTATION_CASE_NOT_ENABLED/);
  process.env.G5_H5_MUTATIONS = 'disabled';
  await assert.rejects(authorizeMutation({ stage: 'reserve', plan, authorization: buildAuthorization(), execute: true }), /MUTATION_PLAN_IDENTIFIERS_INVALID/);
});

test('ejecutar-integracion directo no inicia reserve sin pasar por el wrapper ni aportar autorización', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'g6-h5-direct-stage-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const gateway = 'https://gateway.example.invalid';
  const planPath = join(dir, 'plan.json');
  await writeFile(planPath, JSON.stringify({
    case_id: 'G5-H5-01', environment: 'integration', gateway, g5_sha: '1'.repeat(40), g6_sha: '2'.repeat(40),
    order_id: 'SYNTHETIC-ORDER', correlation_id: randomUUID(), operations: { reserve: randomUUID() },
  }));
  const runner = fileURLToPath(new URL('./ejecutar-integracion.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [runner, 'reserve', planPath, join(dir, 'state.json')], {
    encoding: 'utf8',
    env: { ...process.env, G5_H5_AUTHORIZED_GATEWAY_ORIGIN: gateway, G5_H5_VENTAS_JWT: 'test.jwt.value', G5_H5_MUTATIONS: 'integration-only' },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /MUTATION_AUTHORIZATION_FILE_REQUIRED/);
});
