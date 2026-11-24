import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { assertSafeEvidenceText } from '../apps/catalog-svc/test/h5/evidence-security.mjs';

const suites = {
  int01: { config: 'vitest.h5-int01.config.ts', suite: 'INT01_CONTRACT', expected: 10 },
  perf01: { config: 'vitest.h5-perf01.config.ts', suite: 'PERF01_ORACLE', expected: 14 },
};
const selected = suites[process.argv[2]];
if (!selected) throw new Error('H5_VITEST_SUITE_INVALID: use int01 or perf01');
const summaryPath = resolve('apps/catalog-svc/test/h5/reports', `${process.argv[2]}.json`);
await mkdir(dirname(summaryPath), { recursive: true });
try { await unlink(summaryPath); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
const child = spawn(process.execPath, [
  'node_modules/vitest/vitest.mjs', 'run', '--config', selected.config,
], {
  stdio: ['ignore', 'pipe', 'pipe'],
  shell: false,
  env: { ...process.env, G6_H5_VITEST_SUMMARY: summaryPath },
});
let capturedBytes = 0;
child.stdout.on('data', chunk => { capturedBytes += chunk.length; });
child.stderr.on('data', chunk => { capturedBytes += chunk.length; });
const exitCode = await new Promise((resolvePromise, reject) => {
  child.once('error', reject);
  child.once('close', resolvePromise);
});
let summary;
let summarySha256;
try {
  const bytes = await readFile(summaryPath);
  const content = bytes.toString('utf8');
  assertSafeEvidenceText(content);
  summary = JSON.parse(content);
  summarySha256 = createHash('sha256').update(bytes).digest('hex');
} catch {
  summary = null;
}
const expectedValid = summary?.suite === selected.suite && summary?.total === selected.expected && summary?.passed === selected.expected && summary?.failed === 0 && summary?.skipped === 0 && summary?.pending === 0 && summary?.status === 'PASS';
if (!expectedValid || exitCode !== 0) {
  process.stdout.write(`H5 ${selected.suite} ${summary?.status === 'NOT_RUN' ? 'NOT_RUN' : 'FAIL'}: expected=${selected.expected}; observed=${summary?.total ?? 0}; skipped=${summary?.skipped ?? 0}; runner_exit=${exitCode}; captured_bytes=${capturedBytes}.\n`);
  process.exit(1);
}
process.stdout.write(`H5 ${selected.suite} PASS: tests=${summary.total}; evidence_sha256=${summarySha256}; captured_bytes=${capturedBytes}.\n`);
