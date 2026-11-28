import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const identifier = /^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$/;
const utcSecond = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const roles = ['INFRA', 'G7'];
const trustFile = new URL('../config/staging-authorities.json', import.meta.url);
const bindings = [
  'environment', 'origin', 'method', 'case_id', 'operation_id', 'channel', 'profile',
  'vus', 'duration_seconds', 'max_rps', 'subject', 'repetition', 'window_start_utc', 'window_end_utc',
  'infra_approval_ref', 'revision', 'backend_sha', 'subject_digest', 'release_manifest_sha256',
  'comparison_context_sha256', 'dataset_sha256', 'negative_401', 'token_sha256', 'harness_commit',
];

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
  for (const field of bindings) {
    if (!Object.hasOwn(expected, field) || !Object.hasOwn(permit, field) || permit[field] !== expected[field]) {
      throw new Error('PREFLIGHT_PERMISO_NO_CORRESPONDE');
    }
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
