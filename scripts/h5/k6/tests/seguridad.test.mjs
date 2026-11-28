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
