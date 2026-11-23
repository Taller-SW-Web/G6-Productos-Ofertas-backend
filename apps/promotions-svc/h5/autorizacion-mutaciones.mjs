import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { constanciaComercial } from './evidencia-integracion.mjs';

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const sha = /^[a-f0-9]{40}$/i;
const signatureText = /^[A-Za-z0-9_-]+$/;
const mutatingStages = new Set(['reserve', 'coupon', 'confirm', 'cancel']);
const scenarios = JSON.parse(await readFile(new URL('./escenarios.json', import.meta.url), 'utf8'));
const fail = (code) => { throw new Error(code); };

function isHttpsReference(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}

function operationFor(stage, plan) {
  if (stage === 'cancel') return plan.operations?.release;
  return plan.operations?.[stage];
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

export function mutationPlanDigest(plan) {
  return createHash('sha256').update(stableJson(plan)).digest('hex');
}

export async function readMutationAuthorization(path) {
  if (typeof path !== 'string' || !path.trim()) fail('MUTATION_AUTHORIZATION_FILE_REQUIRED');
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    fail('MUTATION_AUTHORIZATION_FILE_INVALID');
  }
}

export async function loadMutationAuthorization(input) {
  if (typeof input === 'string') return readMutationAuthorization(input);
  return input;
}

export async function authorizeMutation({ stage, plan, authorization, execute }) {
  if (!mutatingStages.has(stage)) return undefined;
  if (execute !== true || authorization?.execute !== true)
    fail('MUTATION_CASE_NOT_ENABLED');
  if (plan?.environment !== 'integration' ||
      process.env.G5_H5_MUTATIONS !== 'integration-only' ||
      !sha.test(plan.g5_sha ?? '') || !sha.test(plan.g6_sha ?? '') ||
      typeof plan.order_id !== 'string' || !plan.order_id.trim() ||
      !uuid.test(plan.correlation_id ?? '') ||
      !uuid.test(operationFor(stage, plan) ?? '') ||
      (['coupon', 'confirm', 'cancel'].includes(stage) && !uuid.test(plan.reservation_id ?? '')) ||
      (stage === 'cancel' && plan.cancel_mode !== 'release-only' &&
        !uuid.test(plan.operations?.restore ?? '')))
    fail('MUTATION_PLAN_IDENTIFIERS_INVALID');
  let gateway;
  try { gateway = new URL(plan.gateway); } catch { fail('MUTATION_GATEWAY_INVALID'); }
  if (gateway.protocol !== 'https:' || gateway.username || gateway.password || gateway.search || gateway.hash ||
      process.env.G5_H5_AUTHORIZED_GATEWAY_ORIGIN !== gateway.origin)
    fail('AUTHORIZED_PRIVATE_GATEWAY_REQUIRED');
  const scenario = scenarios.find(({ id }) => id === plan.case_id);
  if (!scenario || scenario.stage !== stage) fail('MUTATION_STAGE_CASE_MISMATCH');
  const document = authorization.document;
  if (!document || typeof document.payload !== 'string' || typeof document.signature !== 'string' ||
      !signatureText.test(document.payload) || !signatureText.test(document.signature))
    fail('SIGNED_MUTATION_AUTHORIZATION_REQUIRED');
  let payload;
  try { payload = JSON.parse(Buffer.from(document.payload, 'base64url').toString('utf8')); }
  catch { fail('SIGNED_MUTATION_AUTHORIZATION_INVALID'); }
  let key;
  try { key = createPublicKey(await readFile(process.env.G5_H5_MUTATION_AUTHORIZATION_PUBLIC_KEY)); }
  catch { fail('MUTATION_AUTHORIZATION_PUBLIC_KEY_REQUIRED'); }
  const bytes = Buffer.from(document.payload, 'base64url');
  const signature = Buffer.from(document.signature, 'base64url');
  if (key.asymmetricKeyType !== 'ed25519' || signature.length !== 64 || !verify(null, bytes, key, signature))
    fail('SIGNED_MUTATION_AUTHORIZATION_INVALID');
  const operationId = operationFor(stage, plan);
  const reservationId = ['coupon', 'confirm', 'cancel'].includes(stage) ? plan.reservation_id : null;
  const restoreOperationId = stage === 'cancel' && plan.cancel_mode !== 'release-only'
    ? plan.operations?.restore
    : null;
  const issued = Date.parse(payload.issued_at);
  const expires = Date.parse(payload.expires_at);
  const now = Date.now();
  if (payload.issuer !== 'G6_H5_MUTATION_AUTHORIZATION' ||
      typeof payload.authorized_by !== 'string' || !payload.authorized_by.trim() ||
      payload.case_id !== plan.case_id || payload.stage !== stage || payload.execute !== true ||
      payload.environment !== 'integration' || payload.gateway !== gateway.origin ||
      payload.g5_sha !== plan.g5_sha || payload.g6_sha !== plan.g6_sha ||
      payload.order_id !== plan.order_id || payload.correlation_id !== plan.correlation_id ||
      payload.operation_id !== operationId || payload.reservation_id !== reservationId ||
      payload.restore_operation_id !== restoreOperationId ||
      payload.plan_sha256 !== mutationPlanDigest(plan) ||
      !isHttpsReference(payload.window_approval_ref) ||
      !isHttpsReference(payload.fixture_authorization_ref) ||
      !Number.isFinite(issued) || !Number.isFinite(expires) || issued > now || expires <= now ||
      expires <= issued || expires - issued > 24 * 60 * 60 * 1000)
    fail('SIGNED_MUTATION_AUTHORIZATION_MISMATCH');
  if (scenario.requires_g5_signature) {
    const event = stage === 'confirm' ? 'PAGO_CONFIRMADO' : 'ANULACION_CONFIRMADA';
    await constanciaComercial(plan, event);
  }
  return payload;
}
