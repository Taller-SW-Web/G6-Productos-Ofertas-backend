import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
const performance = readFileSync('.github/workflows/performance-g6.yml', 'utf8');
const persistence = readFileSync('scripts/ci/run-postgres-persistence.mjs', 'utf8');
const summary = readFileSync('scripts/performance/summarize-selection.mjs', 'utf8');
const draftTests = readFileSync('scripts/ci/draft-ready-policy.test.mjs', 'utf8');
const e2eConfig = readFileSync('vitest.config.e2e.ts', 'utf8');
const taxonomyRunner = readFileSync('scripts/ci/run-taxonomy-integration.mjs', 'utf8');
const catalogRunner = readFileSync('scripts/ci/run-catalog-postgres.mjs', 'utf8');
const catalogPersistenceSuite = readFileSync('apps/catalog-svc/test/postgres.persistence.e2e-spec.ts', 'utf8');
const ciTests = readFileSync('.github/workflows/ci.yml', 'utf8');

for (const job of ['taxonomia_catalogo', 'inventario', 'combos_catalogo']) {
  assert.doesNotMatch(ci, new RegExp(`^  ${job}:`, 'm'), `${job} removed`);
  assert.doesNotMatch(ci, new RegExp(`^\\s+- ${job}$`, 'm'), `${job} removed from needs`);
}
assert.match(ci, /^  taxonomia:/m, 'the real PostgreSQL taxonomy job remains');
assert.match(ci, /^  catalogo_postgres:/m, 'the partial Catalog PostgreSQL job remains');
assert.match(ci, /run-catalog-postgres\.mjs/);
assert.match(ci, /catalogo_postgres/);
assert.match(catalogRunner, /expectedTitles/);
assert.match(catalogRunner, /numPassedTests/);
assert.match(catalogRunner, /G6_CATALOG_POSTGRES_CI/);
assert.match(catalogRunner, /originalHistoricalSuiteCases: 47/);
assert.match(catalogRunner, /fullOriginalHistoricalSuiteExecuted: false/);
for (const title of [
  'creates simple and variant products atomically with the correct preparation and Outbox intents',
  'rolls back operation failures and reports deferred aggregate constraints at commit',
  'persists the exact product deactivation event once under concurrent retries',
  'reads contractual preparation, variants and physical SKU data from the committed aggregate',
]) {
  assert.ok(catalogRunner.includes(title), `Catalog partial suite selects ${title}`);
  assert.ok(catalogPersistenceSuite.includes(title), `Catalog historical suite retains ${title}`);
}
assert.match(catalogPersistenceSuite, /if \(!postgresCiOnly\) await jointBroker\.start\(\)/);
assert.match(persistence, /import-prices\.postgres\.e2e-spec\.ts/);
assert.match(persistence, /enabled: 'PRICING_TEST_POSTGRES'/);
assert.match(ci, /^  gateway_inventory_postgres:/m);
assert.match(ci, /options: \[catalog, pricing, promotions, inventory-gateway\]/);
assert.match(ci, /name: Validación de checks CI preservados/);
assert.match(e2eConfig, /G6_SKIP_H4_AMQP_E2E/);
assert.match(ciTests, /G6_SKIP_H4_AMQP_E2E: '1'/);
assert.match(taxonomyRunner, /--testNamePattern/);
assert.match(taxonomyRunner, /\^\(\?!\.\*RabbitMQ real\)/);
assert.match(taxonomyRunner, /solo se permiten los dos casos RabbitMQ H4 manuales/);
assert.match(ci, /run-h5-postgres\.mjs/);
assert.doesNotMatch(ci, /coupons\.isolated\.smoke\.mjs/);
assert.match(ci, /run-postgres-persistence\.mjs/);
assert.match(persistence, /PRICING_TEST_POSTGRES/);
assert.match(persistence, /PRICE_AUDIT_TEST_POSTGRES/);
assert.match(persistence, /numPassedTests/);
assert.match(persistence, /PRICING_TEST_AMQP/);
assert.match(persistence, /PRICE_AUDIT_TEST_AMQP/);
assert.doesNotMatch(ci, /PRICING_TEST_AMQP|PRICE_AUDIT_TEST_AMQP/);
assert.doesNotMatch(ci, /Comprobar integración de Combos obligatoria/);
assert.match(ci, /node scripts\/ci\/verify-ci-results\.mjs/);

for (const removed of [
  'price_audit_http_performance',
  'bulk_http_performance',
  'combos_pricing_http_performance',
  'taxonomy_http_performance',
])
  assert.doesNotMatch(performance, new RegExp(`^  ${removed}:`, 'm'));
for (const unavailable of ['combos', 'bulk', 'price-audit', 'taxonomy']) {
  assert.doesNotMatch(performance, new RegExp(`^\\s+- ${unavailable}$`, 'm'));
  assert.match(summary, new RegExp(`['\\"]?${unavailable}['\\"]?:`));
}
assert.match(summary, /NO_DISPONIBLE/);
assert.match(summary, /integral: false/);
assert.match(summary, /PASS_SELECTED_SCENARIOS/);
assert.match(performance, /summary:/);
assert.doesNotMatch(performance, /rabbitmq|amqp/i);
assert.match(draftTests, /workflows históricos RabbitMQ H4 fueron retirados/);
const temporaryDirectory = mkdtempSync(join(tmpdir(), 'g6-performance-summary-'));
try {
  const summaryScript = resolve('scripts/performance/summarize-selection.mjs');
  for (const component of ['combos', 'bulk', 'price-audit', 'taxonomy']) {
    const run = spawnSync(process.execPath, [summaryScript], {
      cwd: temporaryDirectory,
      env: { ...process.env, COMPONENT: component, JOB_RESULTS: '{}' },
      encoding: 'utf8',
    });
    assert.equal(run.status, 0, `${component} summary succeeds`);
    const output = JSON.parse(run.stdout);
    assert.equal(output.classification, 'NO_DISPONIBLE');
    assert.ok(output.limitation);
    assert.deepEqual(output.scenarios, {});
  }
  const selectedRun = spawnSync(process.execPath, [summaryScript], {
    cwd: temporaryDirectory,
    env: {
      ...process.env,
      COMPONENT: 'pricing',
      JOB_RESULTS: JSON.stringify({
        preflight: { result: 'success' },
        pricing_individual_http_performance: { result: 'success' },
      }),
    },
    encoding: 'utf8',
  });
  assert.equal(selectedRun.status, 0);
  assert.equal(JSON.parse(selectedRun.stdout).classification, 'PASS_SELECTED_SCENARIOS');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
console.log('PASS: CI jobs, PostgreSQL selections, unavailable scenarios, and aggregators are structurally consistent.');
