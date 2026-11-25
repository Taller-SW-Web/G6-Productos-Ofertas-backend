import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const simulatedByCase = new Set(['INT01-CATEGORIA-INVALIDA', 'INT01-MARCA-INVALIDA']);

export default class Int01LocalCatalogReporter {
  async onTestRunEnd(testModules, unhandledErrors, reason) {
    const tests = testModules.flatMap(module => Array.from(module.children.allTests()));
    const cases = tests.map(testCase => {
      const id = /^(INT0[18]-[A-Z0-9-]+):/.exec(testCase.name)?.[1] ?? 'INT01-L1-UNMAPPED';
      const state = testCase.result().state;
      const status = state === 'passed' ? 'PASS' : state === 'failed' ? 'FAIL' : 'NOT_RUN';
      return {
        scenario_id: id,
        status,
        execution: status === 'PASS' || status === 'FAIL' ? 'EXECUTED' : 'NOT_EXECUTED',
        evidence_level: 'L1_CATALOG_POSTGRES',
        providers_started: status === 'NOT_RUN' ? [] : ['api-gateway-local', 'catalog-svc-nest-local', 'postgresql-disposable', ...(id.startsWith('INT08-') ? ['playwright-chromium-local', 'vite-test-proxy-local'] : [])],
        providers_queried: status === 'NOT_RUN' ? [] : ['catalog-svc'],
        providers_participating: status === 'NOT_RUN' ? [] : ['catalog-svc'],
        simulated_providers: simulatedByCase.has(id) ? ['taxonomy-http-fixture'] : [],
        identity_authorization: status === 'NOT_RUN' ? 'NOT_RUN' : id === 'INT01-CATALOG-AUTH-SUBCASE' ? 'synthetic JWT: missing identity, denied role and authorized read' : id.startsWith('INT08-') ? 'synthetic loopback JWT: absent identity, denied role, authorized read and absent resource' : 'synthetic loopback JWT with Catalog role',
        ...(id === 'INT08-L1-INDEPENDENT-BROWSER' ? { source_sha: process.env.CATALOG_REAL_FRONTEND_SHA ?? null } : {}),
      };
    });
    const passed = cases.filter(item => item.status === 'PASS').length;
    const failed = cases.filter(item => item.status === 'FAIL').length;
    const notRun = cases.filter(item => item.status === 'NOT_RUN').length;
    const summary = {
      schema_version: 1,
      suite: 'INT01_LOCAL_CATALOG_L1',
      status: reason === 'passed' && cases.length === (process.env.CATALOG_REAL_FRONTEND_ROOT ? 8 : 7) && passed === cases.length && failed === 0 && notRun === 0 && unhandledErrors.length === 0 ? 'PASS' : 'FAIL',
      total: cases.length,
      executed: passed + failed,
      passed,
      failed,
      not_run: notRun,
      unhandled_error_count: unhandledErrors.length,
      integration_mode: 'real Catalog Nest application in process + real local Gateway process + disposable PostgreSQL TLS; Taxonomy HTTP fixture; no Pricing, Inventory, Azure, APIM, G7, Supabase or shared broker',
      cases,
    };
    const path = resolve(process.env.G6_H5_INT01_L1_SUMMARY_PATH ?? 'test-results/h5/int01-l1-local-inner.json');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
    process.stdout.write(`INT01 local L1: discovered=${summary.total}; executed=${summary.executed}; passed=${passed}; failed=${failed}; not_run=${notRun}.\n`);
  }
}
