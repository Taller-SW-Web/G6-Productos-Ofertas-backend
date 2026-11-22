import { createPublicKey, verify } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export async function constanciaFirmada(documento, variable, codigo) {
  try {
    const key = createPublicKey(await readFile(process.env[variable]));
    const payload = Buffer.from(documento.payload, 'base64url');
    const signature = Buffer.from(documento.signature, 'base64url');
    if (
      key.asymmetricKeyType !== 'ed25519' ||
      signature.length !== 64 ||
      !verify(null, payload, key, signature)
    )
      throw new Error();
    return JSON.parse(payload.toString('utf8'));
  } catch {
    throw new Error(codigo);
  }
}

export async function constanciaComercial(plan, evento) {
  const codigo = 'G5_SIGNED_BUSINESS_EVIDENCE_REQUIRED';
  const proof = await constanciaFirmada(
    plan.g5_evidence,
    'G5_H5_G5_EVIDENCE_PUBLIC_KEY',
    codigo,
  );
  const occurred = Date.parse(proof?.occurred_at);
  const effectiveAt = Date.parse(plan.effective_at);
  if (
    proof?.issuer !== 'G5' ||
    proof.environment !== 'integration' ||
    proof.event !== evento ||
    proof.g5_sha !== plan.g5_sha ||
    proof.g6_sha !== plan.g6_sha ||
    proof.gateway !== new URL(plan.gateway).origin ||
    proof.order_id !== plan.order_id ||
    proof.reservation_id !== plan.reservation_id ||
    proof.coupon_operation_id !== plan.operations?.coupon ||
    typeof proof.event_id !== 'string' ||
    !/^[A-Za-z0-9_-]{1,100}$/.test(proof.event_id) ||
    !Number.isFinite(occurred) ||
    occurred > Date.now() ||
    !Number.isFinite(effectiveAt) ||
    occurred < effectiveAt
  )
    throw new Error(codigo);
  return proof;
}
