import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { verifyReportProvenance } from '../bin/provenance.mjs';

const scopes = {
  'PERF-01': 'L1_FIXTURE_SINTETICO',
  'PERF-02': 'L1_NEST_FIXTURES',
  'PERF-03': 'L1_NEST_FIXTURES',
};
for (const [caseId, scope] of Object.entries(scopes)) {
  const directory = new URL('../evidence/local/' + caseId + '/', import.meta.url);
  const bytes = readFileSync(new URL('summary.json', directory));
  const hash = createHash('sha256').update(bytes).digest('hex');
  assert.equal(readFileSync(new URL('summary.sha256', directory), 'utf8'), hash + '  summary.json\n');
  const report = JSON.parse(bytes);
  verifyReportProvenance(report);
  assert.equal(report.schema_version, 2);
  assert.equal(report.case_id, caseId);
  assert.equal(report.scope, scope);
  assert.equal(report.backend_sha, report.harness_commit);
  assert.equal(report.staging_permit_sha256, null);
  assert.equal(report.official_h5_03, 'NO_CERTIFICADO');
  assert.equal(report.status, 'PASS');
  assert.equal(report.k6_exit_code, 0);
  assert.match(report.dataset_sha256, /^[a-f0-9]{64}$/);
  assert.match(report.k6_version, /^\d+\.\d+\.\d+$/);
  assert.equal(report.metrics.observed_max_vus, 1);
  assert.equal(report.metrics.configured_seconds, 60);
  assert.equal(report.metrics.rps_configured_cap, 2);
  assert.equal(report.metrics.unexpected_error_rate, 0);
  assert.equal(report.metrics.critical_checks, 1);
  assert.equal(report.metrics.negative_401, 1);
  assert.ok(report.metrics.valid_2xx > 0 && report.metrics.completed);
  assert.ok(!/https?:\/\/|authorization|bearer|jwt|eyJ[A-Za-z0-9_-]+\./i.test(bytes.toString('utf8')), 'EVIDENCIA_CON_DATO_SENSIBLE');
  process.stdout.write(caseId + ' resumen, checksum y Git verificados\n');
}
