import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export default class H5SafeVitestReporter {
  constructor(options = {}) {
    this.suite = options.suite;
    this.expectedTests = options.expectedTests;
    this.summaryPath = options.summaryPath;
  }

  async onTestRunEnd(testModules) {
    const cases = testModules.flatMap(module => Array.from(module.children.allTests()));
    const result = {
      schemaVersion: 1,
      suite: this.suite,
      status: 'NOT_RUN',
      total: cases.length,
      passed: cases.filter(item => item.result().state === 'passed').length,
      failed: cases.filter(item => item.result().state === 'failed').length,
      skipped: cases.filter(item => item.result().state === 'skipped').length,
      pending: cases.filter(item => item.result().state === 'pending').length,
    };
    if (result.total > 0) {
      result.status = result.total === this.expectedTests && result.passed === this.expectedTests && result.failed === 0 && result.skipped === 0 && result.pending === 0
        ? 'PASS'
        : 'FAIL';
    }
    const serialized = `${JSON.stringify(result, null, 2)}\n`;
    const absolutePath = resolve(this.summaryPath);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, serialized, 'utf8');
    const sha256 = createHash('sha256').update(serialized, 'utf8').digest('hex');
    process.stdout.write(`H5 ${result.suite} ${result.status}: total=${result.total}; passed=${result.passed}; failed=${result.failed}; skipped=${result.skipped}; pending=${result.pending}; evidence_sha256=${sha256}.\n`);
  }
}
