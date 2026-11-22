import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ejecutarMatriz } from './ejecutar-matriz.mjs';

test('clasifica homologación técnica y bilateral', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'g6-h5-matrix-'));
  const plan = {
    environment: 'integration',
    gateway: 'https://integration.example.invalid',
    g5_sha: '1'.repeat(40),
    g6_sha: '2'.repeat(40),
    order_id: 'PED-AUDITADO',
    reservation_id: randomUUID(),
    operations: { reserve: randomUUID(), coupon: randomUUID() },
  };
  const planPath = join(dir, 'plan.json');
  const keyPath = join(dir, 'public.pem');
  const keys = generateKeyPairSync('ed25519');
  const variable = 'G5_H5_SESSION_EVIDENCE_PUBLIC_KEY';
  const previous = process.env[variable];
  t.after(async () => {
    if (previous === undefined) delete process.env[variable];
    else process.env[variable] = previous;
    await rm(dir, { recursive: true, force: true });
  });
  await writeFile(planPath, JSON.stringify(plan));
  await writeFile(
    keyPath,
    keys.publicKey.export({ type: 'spki', format: 'pem' }),
  );
  process.env[variable] = keyPath;
  const coupon = 'G5-H5-05';
  const fixture = { plan: planPath, execute: true };
  const admission = {
    method: 'POST',
    status: 202,
    operation_id: plan.operations.coupon,
  };
  const completion = {
    event: 'terminal',
    status: 'COMPLETED',
    operation_id: plan.operations.coupon,
  };
  const output = (...events) => ({
    status: 0,
    stdout: events
      .map((event) =>
        JSON.stringify({
          environment: plan.environment,
          g5_sha: plan.g5_sha,
          g6_sha: plan.g6_sha,
          order_id: plan.order_id,
          ...event,
        }),
      )
      .join('\n'),
  });
  const signed = (overrides = {}) => {
    const payload = Buffer.from(
      JSON.stringify({
        case_id: coupon,
        actor: 'G5+G6',
        environment: plan.environment,
        gateway: plan.gateway,
        g5_sha: plan.g5_sha,
        g6_sha: plan.g6_sha,
        order_id: plan.order_id,
        operation_or_reservation_id: plan.operations.coupon,
        observed_at: new Date().toISOString(),
        observed: 'CUPON_202_Y_COMPLETED',
        evidence_url: 'https://evidence.example.invalid/coupon',
        status: 'PASS',
        ...overrides,
      }),
    );
    return {
      payload: payload.toString('base64url'),
      signature: sign(null, payload, keys.privateKey).toString('base64url'),
    };
  };
  const scenario = async (id, record, result) => {
    const report = await ejecutarMatriz({ [id]: record }, [id], () => result);
    assert.equal(report.results.length, 20);
    return report.results.find((row) => row.id === id);
  };
  const validRun = output(admission, completion);
  await t.test('G5-H5-05 sin constancia queda BLOCKED', async () => {
    const row = await scenario(coupon, fixture, validRun);
    assert.equal(row.status, 'BLOCKED');
    assert.equal(row.reason, 'FALTA_CONSTANCIA_BILATERAL');
  });
  await t.test('G5-H5-05 con ambas evidencias pasa', async () => {
    assert.equal(
      (await scenario(coupon, { ...fixture, attestation: signed() }, validRun))
        .status,
      'PASS',
    );
  });
  await t.test(
    'G5-H5-05 conserva el FAIL técnico aunque exista constancia',
    async () => {
      for (const result of [
        { status: 1, stderr: '{"code":"COUPON_NOT_COMPLETED"}' },
        output(admission, { ...completion, operation_id: randomUUID() }),
        output(admission, { ...completion, g6_sha: 'd'.repeat(40) }),
        output(admission),
      ])
        assert.equal(
          (
            await scenario(
              coupon,
              { ...fixture, attestation: signed() },
              result,
            )
          ).status,
          'FAIL',
        );
    },
  );
  await t.test(
    'para G5-H5-05 la firma o los vínculos incorrectos y la ejecución ausente bloquean',
    async () => {
      for (const attestation of [
        { ...signed(), signature: Buffer.alloc(64).toString('base64url') },
        signed({ case_id: 'G5-H5-02' }),
        signed({ environment: 'production' }),
        signed({ g6_sha: 'a'.repeat(40) }),
        signed({ g5_sha: 'b'.repeat(40) }),
        signed({ order_id: 'OTRO' }),
        signed({ operation_or_reservation_id: plan.reservation_id }),
        signed({ operation_or_reservation_id: plan.operations.reserve }),
      ])
        assert.equal(
          (await scenario(coupon, { ...fixture, attestation }, validRun))
            .status,
          'BLOCKED',
        );
      assert.equal(
        (
          await scenario(
            coupon,
            { ...fixture, execute: false, attestation: signed() },
            validRun,
          )
        ).status,
        'BLOCKED',
      );
    },
  );
  await t.test(
    'exige constancia en un caso G7 y permite PASS automático para G6',
    async () => {
      assert.equal(
        (
          await scenario(
            'G5-H5-14',
            fixture,
            output({
              event: 'uniform_coupon_not_found',
              operation_id: plan.operations.coupon,
            }),
          )
        ).status,
        'BLOCKED',
      );
      const reserve = output({
        event: 'terminal',
        status: 'COMPLETED',
        reservation_id: plan.reservation_id,
      });
      assert.equal(
        (await scenario('G5-H5-01', fixture, reserve)).status,
        'PASS',
      );
    },
  );
});
