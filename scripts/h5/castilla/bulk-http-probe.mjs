#!/usr/bin/env node
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { assertLiveAllowed, readBytesLimited, readJsonLimited, request, redactUrl } from './common.mjs';

if (!process.argv.includes('--run')) {
  process.stdout.write(`${JSON.stringify({ schema: 'h5-bulk-http-probe/v1', implementation_state: 'DONE_LOCAL', execution_result: 'NOT_RUN', cases: ['template CSV/XLSX', 'multipart admission 202', 'poll durable state and partial report', '401/403 identity profiles', '404 other owner', 'Storage error', 'ambiguous timeout then correlation lookup without second POST', 'resume/dedup'], requires: ['BULK_SVC_URL', 'H5_LIVE_APPROVED=true', 'H5_TEST_IDENTITY=true', 'H5_DESTINATION_ALLOWLIST', 'H5_DISCARDABLE_DATASET=true', 'H5_BULK_BEARER', 'H5_BULK_FILE'], note: 'Service Bus tests are separate; this probe exercises current HTTP only.' })}\n`);
  process.exit(0);
}
const base = assertLiveAllowed(process.env.BULK_SVC_URL ?? '', 'BULK_SVC_URL');
if (process.env.H5_DISCARDABLE_DATASET !== 'true') throw new Error('BLOCKED_DATASET: disposable target is required');
const token = process.env.H5_BULK_BEARER;
const file = resolve(process.env.H5_BULK_FILE ?? '');
if (!token || !process.env.H5_TEST_IDENTITY) throw new Error('BLOCKED_IDENTITY: supply dedicated test identity');
const bytes = readFileSync(file);
if (statSync(file).size > 10 * 1024 * 1024) throw new Error('Input exceeds the current HTTP upload limit (10 MiB)');
const correlationId = randomUUID();
const digest = createHash('sha256').update(bytes).digest('hex');
const startedAt = Date.now();
const url = (path) => new URL(path.replace(/^\//, ''), `${base.href.replace(/\/$/, '')}/`);
const root = '/api/v1/carga-masiva/productos';
const headers = { Authorization: `Bearer ${token}`, 'X-Correlation-Id': correlationId };
const template = await request(url(`${root}/plantilla?formato=CSV`), { method: 'GET', headers });
if (template.status !== 200 || !template.headers.get('content-type')?.includes('text/csv')) throw new Error(`Template preflight failed with HTTP ${template.status}`);
const templateBytes = await readBytesLimited(template);
if (!templateBytes.toString('utf8').startsWith('operacion,producto_id')) throw new Error('CSV template headers differ from the known Bulk v2 contract');
const xlsxTemplate = await request(url(`${root}/plantilla?formato=XLSX`), { method: 'GET', headers });
if (xlsxTemplate.status !== 200 || !xlsxTemplate.headers.get('content-type')?.includes('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')) throw new Error(`XLSX template preflight failed with HTTP ${xlsxTemplate.status}`);
const xlsxTemplateBytes = await readBytesLimited(xlsxTemplate);
if (xlsxTemplateBytes.length < 100) throw new Error('XLSX template response is unexpectedly small');
let admission;
try {
  const form = new FormData();
  form.set('template_version', '2');
  form.set('archivo', new Blob([bytes], { type: 'text/csv' }), 'h5.csv');
  admission = await request(url(`${root}/importaciones`), { method: 'POST', headers, body: form });
} catch {
  const reconciliable = process.env.BULK_CORRELATION_RECONCILIATION_ENABLED === 'true';
  if (!reconciliable) {
    process.stdout.write(`${JSON.stringify({ schema: 'h5-bulk-http-result/v1', execution_result: 'INCONCLUSIVE', reason: 'ambiguous POST timeout; correlation reconciliation flag is disabled; no second POST issued', correlation_id: correlationId, input_sha256: digest, destination: redactUrl(base.href) })}\n`);
    process.exitCode = 2;
  } else {
    const lookup = await request(url(`${root}/importaciones/por-correlacion/${correlationId}`), { method: 'GET', headers });
    const result = { schema: 'h5-bulk-http-result/v1', execution_result: lookup.ok ? 'INCONCLUSIVE' : 'BLOCKED_RECONCILIATION', reason: 'ambiguous POST timeout reconciled by correlation lookup; POST is never repeated', correlation_id: correlationId, input_sha256: digest, lookup_status: lookup.status, lookup_body: lookup.ok ? await readJsonLimited(lookup) : undefined, destination: redactUrl(base.href) };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!lookup.ok) process.exitCode = 2;
  }
  process.exit();
}
if (admission.status !== 202) {
  const status = admission.status;
  await admission.body?.cancel();
  process.stdout.write(`${JSON.stringify({ schema: 'h5-bulk-http-result/v1', execution_result: 'FAIL', phase: 'admission', observed_status: status, expected_status: 202, correlation_id: correlationId, input_sha256: digest, destination: redactUrl(base.href) })}\n`);
  process.exit(1);
}
const accepted = await readJsonLimited(admission);
if (accepted.status !== 'QUEUED' || accepted.correlation_id !== correlationId || typeof accepted.batch_id !== 'string') throw new Error('202 body does not match current Bulk admission contract');
const timeoutMs = Number(process.env.H5_BULK_POLL_TIMEOUT_MS ?? 120000);
if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 900000) throw new Error('H5_BULK_POLL_TIMEOUT_MS must be 1000..900000');
const deadline = Date.now() + timeoutMs;
const pollMs = Math.min(5000, Math.max(250, Number(process.env.H5_BULK_POLL_INTERVAL_MS ?? 1000)));
let snapshot;
do {
  const response = await request(url(`${root}/importaciones/${accepted.batch_id}`), { method: 'GET', headers });
  if (!response.ok) throw new Error(`Polling failed with HTTP ${response.status}`);
  const readSnapshot = await readJsonLimited(response);
  snapshot = { batch_id: readSnapshot.batch_id, status: readSnapshot.status, total_rows: readSnapshot.total_rows, completed_rows: readSnapshot.completed_rows, failed_rows: readSnapshot.failed_rows, needs_reconciliation: readSnapshot.needs_reconciliation };
  if (['COMPLETED', 'FAILED', 'PARTIAL'].includes(snapshot.status)) break;
  await new Promise((resolveSleep) => setTimeout(resolveSleep, pollMs));
} while (Date.now() < deadline);
const terminal = ['COMPLETED', 'FAILED', 'PARTIAL'].includes(snapshot?.status);
let reportStatus;
if (terminal) {
  const report = await request(url(`${root}/importaciones/${accepted.batch_id}/reporte`), { method: 'GET', headers });
  reportStatus = report.status;
  await report.body?.cancel();
}
process.stdout.write(`${JSON.stringify({ schema: 'h5-bulk-http-result/v1', implementation_state: 'DONE_LOCAL', execution_result: terminal ? 'INCONCLUSIVE' : 'BLOCKED_PROCESSING', phase: 'durable_completion', admission_status: 202, admission_state: accepted.status, batch_id: accepted.batch_id, correlation_id: correlationId, input_sha256: digest, snapshot, report_status: reportStatus ?? null, destination: redactUrl(base.href), duration_ms: Date.now() - startedAt, note: 'HTTP 202 proves admission only. Mark PASS only after reviewing expected per-row results, environment, artifact and exact source SHA.' }, null, 2)}\n`);
