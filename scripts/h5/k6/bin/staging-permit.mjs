import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const identifier = /^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$/;
const utcSecond = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const roles = ['INFRA', 'G7'];
const trustFile = new URL('../config/staging-authorities.json', import.meta.url);
const performanceBindings = [
  'environment', 'origin', 'method', 'case_id', 'operation_id', 'channel', 'profile',
  'vus', 'duration_seconds', 'max_rps', 'subject', 'repetition', 'window_start_utc', 'window_end_utc',
  'infra_approval_ref', 'revision', 'backend_sha', 'subject_digest', 'release_manifest_sha256',
  'comparison_context_sha256', 'dataset_sha256', 'negative_401', 'token_sha256', 'harness_commit',
];
const apimRateLimitBindings = [
  'environment', 'origin', 'method', 'case_id', 'operation_id', 'operation_path', 'channel', 'profile',
  'vus', 'duration_seconds', 'max_rps', 'max_concurrency', 'max_requests', 'max_retry_after_seconds',
  'window_start_utc', 'window_end_utc', 'infra_approval_ref', 'g7_approval_ref', 'revision', 'revision_header',
  'backend_sha', 'policy_hash', 'operation_set_sha256', 'filtered_openapi_sha256',
  'effective_manifest_sha256', 'effective_parameters_sha256', 'rate_profile', 'burst_calls',
  'burst_window_seconds', 'identity', 'token_sha256', 'harness_commit',
];
const apimIsolationBindings = [...apimRateLimitBindings, 'identity_b', 'token_sha256_b'];
const apimQuotaBindings = [...apimRateLimitBindings, 'quota_calls', 'quota_window_seconds', 'quota_error_code'];
const apimConcurrencyBindings = [...apimRateLimitBindings, 'policy_concurrency_limit', 'concurrency_calls'];

function decode(value) {
  if (typeof value !== 'string' || value.length > 32768) throw new Error('PREFLIGHT_PERMISO_FORMATO');
  const bytes = Buffer.from(value, 'base64');
  if (!bytes.length || bytes.toString('base64') !== value) throw new Error('PREFLIGHT_PERMISO_FORMATO');
  return bytes;
}

function readJson(bytes) {
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

export function verifyStagingPermit(envelope, expected, authorities, now = Date.now()) {
  if (!Array.isArray(envelope?.signatures) || envelope.signatures.length !== roles.length) {
    throw new Error('PREFLIGHT_FIRMAS_INFRA_G7_REQUERIDAS');
  }
  const payload = decode(envelope.payload_base64);
  const approvedRoles = new Set();
  const usedKeys = new Set();
  for (const signature of envelope.signatures) {
    const matches = authorities.keys.filter((key) => key.id === signature?.key_id);
    if (matches.length !== 1 || !roles.includes(matches[0].role)) {
      throw new Error('PREFLIGHT_AUTORIDAD_NO_CONFIABLE');
    }
    const authority = matches[0];
    const der = decode(authority.public_key_spki_base64);
    const fingerprint = createHash('sha256').update(der).digest('hex');
    if (approvedRoles.has(authority.role) || usedKeys.has(fingerprint)) {
      throw new Error('PREFLIGHT_FIRMAS_INFRA_G7_REQUERIDAS');
    }
    const key = createPublicKey({ key: der, type: 'spki', format: 'der' });
    if (key.asymmetricKeyType !== 'ed25519' || !verify(null, payload, key, decode(signature.signature_base64))) {
      throw new Error('PREFLIGHT_FIRMA_STAGING_INVALIDA');
    }
    approvedRoles.add(authority.role);
    usedKeys.add(fingerprint);
  }

  const permit = readJson(payload);
  if (permit?.schema_version !== 1 || permit?.environment !== 'STAGING_APIM' ||
      !identifier.test(permit?.g7_approval_ref ?? '') ||
      !/^x-[a-z0-9-]{1,62}$/.test(permit?.revision_header ?? '')) {
    throw new Error('PREFLIGHT_DECLARACION_STAGING_INVALIDA');
  }
  const isApimRateLimit = ['demo-rate-limit', 'aislamiento', 'cuota', 'concurrencia'].includes(expected.profile);
  const bindings = expected.profile === 'aislamiento'
    ? apimIsolationBindings
    : expected.profile === 'cuota' ? apimQuotaBindings
      : expected.profile === 'concurrencia' ? apimConcurrencyBindings
        : expected.profile === 'demo-rate-limit' ? apimRateLimitBindings : performanceBindings;
  for (const field of bindings) {
    if (!Object.hasOwn(expected, field) || !Object.hasOwn(permit, field) || permit[field] !== expected[field]) {
      throw new Error('PREFLIGHT_PERMISO_NO_CORRESPONDE');
    }
  }
  if (isApimRateLimit &&
      (!/^[a-f0-9]{64}$/.test(permit.policy_hash ?? '') ||
       !/^[a-f0-9]{64}$/.test(permit.operation_set_sha256 ?? '') ||
       !/^[a-f0-9]{64}$/.test(permit.filtered_openapi_sha256 ?? '') ||
       !/^[a-f0-9]{64}$/.test(permit.effective_manifest_sha256 ?? '') ||
       !/^[a-f0-9]{64}$/.test(permit.effective_parameters_sha256 ?? '') ||
       !/^[a-f0-9]{64}$/.test(permit.token_sha256 ?? '') ||
       !/^[a-f0-9]{40}$/.test(permit.backend_sha ?? '') ||
       !/^[A-Za-z0-9_-]{1,256}$/.test(permit.identity ?? '') ||
       !Number.isSafeInteger(permit.burst_calls) || permit.burst_calls < 1 ||
       !Number.isSafeInteger(permit.burst_window_seconds) || permit.burst_window_seconds < 1 ||
       !Number.isSafeInteger(permit.max_requests) ||
       !Number.isSafeInteger(permit.max_concurrency) || permit.max_concurrency < 1 ||
       !Number.isSafeInteger(permit.max_retry_after_seconds) || permit.max_retry_after_seconds < 0)) {
    throw new Error('PREFLIGHT_DECLARACION_RATE_LIMIT_INVALIDA');
  }
  if (['demo-rate-limit', 'aislamiento'].includes(expected.profile) &&
      permit.max_requests !== permit.burst_calls + (expected.profile === 'aislamiento' ? 3 : 2)) {
    throw new Error('PREFLIGHT_DECLARACION_RATE_LIMIT_INVALIDA');
  }
  if (expected.profile === 'cuota' &&
      (!Number.isSafeInteger(permit.quota_calls) || permit.quota_calls < 1 ||
       !Number.isSafeInteger(permit.quota_window_seconds) || permit.quota_window_seconds < 1 ||
       !/^[A-Z][A-Z0-9_]{2,63}$/.test(permit.quota_error_code ?? '') ||
       permit.max_requests !== permit.quota_calls + 1 || permit.max_retry_after_seconds !== 0)) {
    throw new Error('PREFLIGHT_DECLARACION_CUOTA_INVALIDA');
  }
  if (expected.profile === 'concurrencia' &&
      (!Number.isSafeInteger(permit.policy_concurrency_limit) || permit.policy_concurrency_limit < 1 ||
       permit.concurrency_calls !== permit.policy_concurrency_limit + 1 ||
       permit.max_requests !== permit.concurrency_calls || permit.max_concurrency !== permit.concurrency_calls ||
       permit.vus !== permit.concurrency_calls || permit.max_rps !== permit.concurrency_calls ||
       permit.max_retry_after_seconds !== 0)) {
    throw new Error('PREFLIGHT_DECLARACION_CONCURRENCIA_INVALIDA');
  }
  if (expected.profile === 'aislamiento' &&
      (!/^[A-Za-z0-9_-]{1,256}$/.test(permit.identity_b ?? '') || !/^[a-f0-9]{64}$/.test(permit.token_sha256_b ?? ''))) {
    throw new Error('PREFLIGHT_DECLARACION_AISLAMIENTO_INVALIDA');
  }
  const start = Date.parse(permit.window_start_utc);
  const end = Date.parse(permit.window_end_utc);
  if (!utcSecond.test(permit.window_start_utc) || !utcSecond.test(permit.window_end_utc) ||
      !Number.isFinite(start) || !Number.isFinite(end) ||
      now < start || now + (expected.duration_seconds + 50) * 1000 >= end) {
    throw new Error('PREFLIGHT_PERMISO_FUERA_DE_VENTANA');
  }
  const origin = new URL(permit.origin);
  if (origin.protocol !== 'https:' || origin.origin !== permit.origin) throw new Error('PREFLIGHT_ORIGEN_NO_CANONICO');
  return {
    permit_sha256: createHash('sha256').update(payload).digest('hex'),
    revision_header: permit.revision_header,
    revision: permit.revision,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [, , permitPath] = process.argv;
    const expected = JSON.parse(process.env.G6_K6_PERMIT_EXPECTED);
    // El operador solo entrega el sobre. Las claves de confianza vienen de este checkout.
    const authority = readJson(readFileSync(trustFile));
    const envelope = readJson(readFileSync(permitPath));
    process.stdout.write(JSON.stringify(verifyStagingPermit(envelope, expected, authority)));
  } catch (error) {
    const message = /^PREFLIGHT_[A-Z0-9_]+$/.test(error.message) ? error.message : 'PREFLIGHT_PERMISO_FORMATO';
    process.stdout.write(message);
    process.exitCode = 2;
  }
}
