import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { assertSafeEvidenceText } from './evidence-security.mjs';

export default class H5SafeVitestReporter {
  constructor(options = {}) {
    this.suite = options.suite;
    this.expectedTests = options.expectedTests;
    this.summaryPath = options.summaryPath;
  }

  async onTestRunEnd(testModules) {
    const cases = testModules.flatMap(module => Array.from(module.children.allTests()));
    const individualCases = cases.map((item, index) => {
      const stableName = item.name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 72) || 'ASSERTION';
      const state = item.result().state;
      return {
        scenario_id: `${this.suite}-${stableName}-${String(index + 1).padStart(3, '0')}`,
        status: state === 'passed' ? 'PASS' : state === 'failed' ? 'FAIL' : 'NOT_RUN',
        result_category: state === 'passed' ? 'ASSERTIONS_PASSED' : state === 'failed' ? 'ASSERTIONS_FAILED' : 'OMITTED_OR_PENDING',
        evidence_level: this.suite === 'INT01_CONTRACT' ? 'L0_CONTRACT' : 'L0_ORACLE',
      };
    });
    const result = {
      schemaVersion: 1,
      suite: this.suite,
      status: 'NOT_RUN',
      total: cases.length,
      passed: cases.filter(item => item.result().state === 'passed').length,
      failed: cases.filter(item => item.result().state === 'failed').length,
      skipped: cases.filter(item => item.result().state === 'skipped').length,
      pending: cases.filter(item => item.result().state === 'pending').length,
      cases: individualCases,
    };
    if (result.total > 0) {
      result.status = result.total === this.expectedTests && result.passed === this.expectedTests && result.failed === 0 && result.skipped === 0 && result.pending === 0
        ? 'PASS'
        : 'FAIL';
    }
    const serialized = `${JSON.stringify(result, null, 2)}\n`;
    assertSafeEvidenceText(serialized);
    const absolutePath = resolve(this.summaryPath);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, serialized, 'utf8');
    const sha256 = createHash('sha256').update(serialized, 'utf8').digest('hex');
    process.stdout.write(`H5 ${result.suite} ${result.status}: total=${result.total}; passed=${result.passed}; failed=${result.failed}; skipped=${result.skipped}; pending=${result.pending}; evidence_sha256=${sha256}.\n`);
  }
}
