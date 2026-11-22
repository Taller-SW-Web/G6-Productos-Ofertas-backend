import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { constanciaComercial } from './evidencia-integracion.mjs';

test('exige una firma G5 vinculada a la operación y usa su instante original', async () => {
  const key = generateKeyPairSync('ed25519');
  const dir = await mkdtemp(join(tmpdir(), 'g6-h5-evidence-'));
  const publicPath = join(dir, 'public.pem');
  const variable = 'G5_H5_G5_EVIDENCE_PUBLIC_KEY';
  const previous = process.env[variable];
  const createProof = (record) => {
    const payload = Buffer.from(JSON.stringify(record));
    return {
      payload: payload.toString('base64url'),
      signature: sign(null, payload, key.privateKey).toString('base64url'),
    };
  };
  const plan = {
    order_id: 'ORDER',
    reservation_id: 'RESERVE',
    operations: { coupon: 'COUPON' },
    g5_sha: '1'.repeat(40),
    g6_sha: '2'.repeat(40),
    gateway: 'https://suite.example.invalid',
    effective_at: '2026-01-19T16:00:00Z',
    g5_payment_ref: 'palabra-sola',
    cancelled_at: '2026-01-19T16:05:00Z',
  };
  const record = {
    issuer: 'G5',
    environment: 'integration',
    event: 'ANULACION_CONFIRMADA',
    gateway: plan.gateway,
    order_id: plan.order_id,
    reservation_id: plan.reservation_id,
    coupon_operation_id: plan.operations.coupon,
    g5_sha: plan.g5_sha,
    g6_sha: plan.g6_sha,
    event_id: 'G5-EVT-12',
    occurred_at: '2026-01-19T16:01:00Z',
  };
  try {
    await writeFile(
      publicPath,
      key.publicKey.export({ type: 'spki', format: 'pem' }),
    );
    process.env[variable] = publicPath;
    await assert.rejects(
      constanciaComercial(plan, 'PAGO_CONFIRMADO'),
      /G5_SIGNED_BUSINESS_EVIDENCE_REQUIRED/,
    );
    const signed = createProof(record);
    for (const wrong of [
      { ...plan, g5_evidence: signed, order_id: 'AJENO' },
      { ...plan, g5_evidence: signed, g6_sha: '3'.repeat(40) },
      {
        ...plan,
        g5_evidence: {
          ...signed,
          signature: Buffer.alloc(64).toString('base64url'),
        },
      },
    ])
      await assert.rejects(
        constanciaComercial(wrong, 'ANULACION_CONFIRMADA'),
        /G5_SIGNED_BUSINESS_EVIDENCE_REQUIRED/,
      );
    await assert.rejects(
      constanciaComercial({ ...plan, g5_evidence: signed }, 'PAGO_CONFIRMADO'),
      /G5_SIGNED_BUSINESS_EVIDENCE_REQUIRED/,
    );
    assert.equal(
      (
        await constanciaComercial(
          { ...plan, g5_evidence: signed },
          'ANULACION_CONFIRMADA',
        )
      ).occurred_at,
      record.occurred_at,
    );
  } finally {
    if (previous === undefined) delete process.env[variable];
    else process.env[variable] = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
