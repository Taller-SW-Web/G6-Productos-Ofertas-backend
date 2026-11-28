import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { harnessPaths, snapshot, verifyReportProvenance } from '../bin/provenance.mjs';
import { verifyStagingPermit } from '../bin/staging-permit.mjs';
import { revisionMatches } from '../scripts/contratos.js';

const now = Date.parse('2026-11-28T10:00:00Z');
const expected = {
  environment: 'STAGING_APIM', origin: 'https://example.invalid', case_id: 'PERF-02', operation_id: 'obtenerPrecioSku',
  method: 'GET', profile: 'demo-normal', vus: 5, duration_seconds: 180, max_rps: 2, channel: 'MARKETPLACE',
  window_start_utc: '2026-11-28T09:59:00Z', window_end_utc: '2026-11-28T10:10:00Z',
  revision: 'REV-FIXTURE', infra_approval_ref: 'INFRA-FIXTURE', backend_sha: 'a'.repeat(40),
  subject_digest: 'sha256:' + 'a'.repeat(64), release_manifest_sha256: 'b'.repeat(64),
  dataset_sha256: 'c'.repeat(64), comparison_context_sha256: 'd'.repeat(64), harness_commit: 'e'.repeat(40),
  token_sha256: 'f'.repeat(64), negative_401: false, subject: 'baseline', repetition: 1,
};
const signer = (role) => ({ role, id: 'TEST-' + role, ...generateKeyPairSync('ed25519') });
const infra = signer('INFRA');
const g7 = signer('G7');
const authorities = { keys: [infra, g7].map(({ role, id, publicKey }) => ({
  role, id, public_key_spki_base64: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
})) };
function envelope(overrides = {}, signers = [infra, g7]) {
  const payload = Buffer.from(JSON.stringify({
    schema_version: 1, g7_approval_ref: 'G7-FIXTURE', revision_header: 'x-fixture-revision',
    ...expected, ...overrides,
  }));
  return {
    payload_base64: payload.toString('base64'),
    signatures: signers.map((key) => ({ key_id: key.id, signature_base64: sign(null, payload, key.privateKey).toString('base64') })),
  };
}

const rateLimitExpected = {
  environment: 'STAGING_APIM', origin: 'https://apim.example.invalid', method: 'GET',
  case_id: 'RL-01-RL-03', operation_id: 'listarProductos', operation_path: '/productos',
  channel: 'MARKETPLACE', profile: 'demo-rate-limit', vus: 1, duration_seconds: 60, max_rps: 3,
  max_concurrency: 3, max_requests: 5, max_retry_after_seconds: 10,
  window_start_utc: '2026-11-28T09:59:00Z', window_end_utc: '2026-11-28T10:10:00Z',
  infra_approval_ref: 'INFRA-FIXTURE', g7_approval_ref: 'G7-FIXTURE', revision: 'REV-FIXTURE',
  revision_header: 'x-fixture-revision', backend_sha: 'a'.repeat(40), policy_hash: 'b'.repeat(64),
  operation_set_sha256: 'c'.repeat(64), filtered_openapi_sha256: 'd'.repeat(64),
  effective_manifest_sha256: 'e'.repeat(64), effective_parameters_sha256: 'f'.repeat(64),
  rate_profile: 'commercial_read', burst_calls: 3, burst_window_seconds: 2,
  identity: 'consumer-A', token_sha256: '1'.repeat(64), harness_commit: '2'.repeat(40),
};

function rateLimitEnvelope(overrides = {}, signers = [infra, g7]) {
  const payload = Buffer.from(JSON.stringify({ schema_version: 1, ...rateLimitExpected, ...overrides }));
  return {
    payload_base64: payload.toString('base64'),
    signatures: signers.map((key) => ({ key_id: key.id, signature_base64: sign(null, payload, key.privateKey).toString('base64') })),
  };
}

test('acepta exclusivamente un permiso con las dos firmas y el contexto correspondiente', () => {
  assert.match(verifyStagingPermit(envelope(), expected, authorities, now).permit_sha256, /^[0-9a-f]{64}$/);
  assert.throws(() => verifyStagingPermit(envelope({}, [infra]), expected, authorities, now), /FIRMAS_INFRA_G7/);
  assert.throws(() => verifyStagingPermit(envelope({}, [infra, infra]), expected, authorities, now), /FIRMAS_INFRA_G7/);
  assert.throws(() => verifyStagingPermit(envelope(), expected, { keys: [] }, now), /AUTORIDAD_NO_CONFIABLE/);
  const forged = { ...signer('INFRA'), id: infra.id };
  assert.throws(() => verifyStagingPermit(envelope({}, [forged, g7]), expected, authorities, now), /FIRMA_STAGING_INVALIDA/);
  const altered = envelope();
  altered.payload_base64 = envelope({ revision: 'OTRA-REVISION' }).payload_base64;
  assert.throws(() => verifyStagingPermit(altered, expected, authorities, now), /FIRMA_STAGING_INVALIDA/);
});

test('el perfil APIM independiente se autoriza solo con presupuesto, operación, política e identidad firmados', () => {
  assert.match(verifyStagingPermit(rateLimitEnvelope(), rateLimitExpected, authorities, now).permit_sha256, /^[0-9a-f]{64}$/);
  for (const overrides of [
    { max_requests: 6 }, { operation_path: '/productos/administracion' },
    { policy_hash: '9'.repeat(64) }, { identity: 'consumer-B' },
    { effective_manifest_sha256: '8'.repeat(64) }, { burst_window_seconds: 3 },
  ]) {
    assert.throws(
      () => verifyStagingPermit(rateLimitEnvelope(overrides), rateLimitExpected, authorities, now),
      /PERMISO_NO_CORRESPONDE/,
    );
  }
  assert.throws(
    () => verifyStagingPermit(rateLimitEnvelope({ max_requests: 4 }), { ...rateLimitExpected, max_requests: 4 }, authorities, now),
    /DECLARACION_RATE_LIMIT_INVALIDA/,
  );
});

test('rechaza un permiso genuino de otro origen, ruta, carga, revisión, código, token o ventana', () => {
  for (const overrides of [
    { origin: 'https://otro.example.invalid' }, { operation_id: 'listarProductos' }, { case_id: 'PERF-01' },
    { profile: 'formal-carga' }, { max_rps: 3 }, { revision: 'OTRA-REVISION' },
    { harness_commit: 'f'.repeat(40) }, { token_sha256: 'e'.repeat(64) },
    { window_end_utc: '2026-11-28T10:20:00Z' },
  ]) {
    assert.throws(() => verifyStagingPermit(envelope(overrides), expected, authorities, now), /PERMISO_NO_CORRESPONDE/);
  }
  assert.throws(() => verifyStagingPermit(envelope(), expected, authorities, now + 600_000), /PERMISO_FUERA_DE_VENTANA/);
  assert.throws(() => verifyStagingPermit(envelope(), { profile: expected.profile }, authorities, now), /PERMISO_NO_CORRESPONDE/);
});

test('los permisos de cuota y concurrencia fijan límites y resultados esperados exactos', () => {
  const quotaExpected = {
    ...rateLimitExpected,
    case_id: 'APIM-QUOTA', profile: 'cuota', max_requests: 5, max_concurrency: 1,
    max_rps: 3, max_retry_after_seconds: 0, burst_calls: 10, burst_window_seconds: 1,
    quota_calls: 4, quota_window_seconds: 300, quota_error_code: 'RATE_LIMIT_CUOTA',
  };
  assert.match(verifyStagingPermit(rateLimitEnvelope(quotaExpected), quotaExpected, authorities, now).permit_sha256, /^[0-9a-f]{64}$/);
  assert.throws(() => verifyStagingPermit(
    rateLimitEnvelope({ ...quotaExpected, quota_error_code: 'SCOPE_INSUFICIENTE' }),
    quotaExpected, authorities, now,
  ), /PERMISO_NO_CORRESPONDE/);
  assert.throws(() => verifyStagingPermit(
    rateLimitEnvelope({ ...quotaExpected, max_requests: 6 }),
    { ...quotaExpected, max_requests: 6 }, authorities, now,
  ), /DECLARACION_CUOTA_INVALIDA/);

  const concurrencyExpected = {
    ...rateLimitExpected,
    case_id: 'RL-06', profile: 'concurrencia', vus: 3, max_requests: 3, max_concurrency: 3,
    max_rps: 3, max_retry_after_seconds: 0, burst_calls: 3, burst_window_seconds: 2,
    policy_concurrency_limit: 2, concurrency_calls: 3,
  };
  assert.match(verifyStagingPermit(rateLimitEnvelope(concurrencyExpected), concurrencyExpected, authorities, now).permit_sha256, /^[0-9a-f]{64}$/);
  assert.throws(() => verifyStagingPermit(
    rateLimitEnvelope({ ...concurrencyExpected, concurrency_calls: 4 }),
    concurrencyExpected, authorities, now,
  ), /PERMISO_NO_CORRESPONDE/);
});

test('la revisión observada debe ser exacta, presente y única', () => {
  const header = 'x-fixture-revision';
  assert.equal(revisionMatches({ 'X-Fixture-Revision': 'REV-FIXTURE' }, header, 'REV-FIXTURE'), true);
  assert.equal(revisionMatches({}, header, 'REV-FIXTURE'), false);
  assert.equal(revisionMatches({ [header]: 'OTRA-REV' }, header, 'REV-FIXTURE'), false);
  assert.equal(revisionMatches({ [header]: 'REV-FIXTURE', 'X-Fixture-Revision': 'OTRA-REV' }, header, 'REV-FIXTURE'), false);
});

test('el código externo alterado y un hash de procedencia falso son rechazados', () => {
  const local = fileURLToPath(new URL('../.local/', import.meta.url));
  mkdirSync(local, { recursive: true });
  const fixture = mkdtempSync(join(local, 'provenance-test-'));
  const git = (...args) => execFileSync('git', ['-C', fixture, ...args], { stdio: 'pipe' });
  git('init', '-q');
  const paths = harnessPaths('PERF-01');
  for (const path of paths) {
    mkdirSync(dirname(join(fixture, path)), { recursive: true });
    writeFileSync(join(fixture, path), 'fixture de procedencia\n');
  }
  git('add', '--', ...paths);
  git('-c', 'user.name=Fixture k6', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Fixture');
  const clean = snapshot('PERF-01', fixture);
  assert.equal(clean.harness_dirty, false);
  verifyReportProvenance({ ...clean, case_id: 'PERF-01' }, fixture);
  const external = paths.find((path) => path.startsWith('apps/'));
  assert.ok(external);
  git('update-index', '--assume-unchanged', external);
  writeFileSync(join(fixture, external), 'cambio externo sin declarar\n');
  assert.equal(git('status', '--porcelain').toString(), '');
  const dirty = snapshot('PERF-01', fixture);
  assert.throws(() => verifyReportProvenance({ ...dirty, case_id: 'PERF-01' }, fixture), /EVIDENCIA_ARNES_SUCIO/);
  assert.throws(() => verifyReportProvenance({
    ...clean, case_id: 'PERF-01', harness_files_sha256: { ...clean.harness_files_sha256, [external]: '0'.repeat(64) },
  }, fixture), /EVIDENCIA_HASH_ARNES_NO_CORRESPONDE/);
});
