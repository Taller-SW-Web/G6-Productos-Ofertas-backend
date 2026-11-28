import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
const config = readFileSync('vitest.config.e2e.ts', 'utf8');
const catalog = readFileSync(
  'apps/catalog-svc/test/postgres.persistence.e2e-spec.ts',
  'utf8',
);
const excluded = [
  'apps/catalog-svc/test/rabbitmq.e2e-spec.ts',
  'apps/taxonomy-svc/test/persistencia-drizzle.e2e-spec.ts',
  'apps/bulk-svc/test/bulk-messaging.e2e-spec.ts',
  'apps/bulk-svc/test/bulk-http-benchmark.e2e-spec.ts',
  'apps/price-audit-svc/test/consumer.amqp.e2e-spec.ts',
  'apps/pricing-svc/test/outbox.amqp.e2e-spec.ts',
  'apps/pricing-svc/test/inbox-consumer.amqp.e2e-spec.ts',
  'apps/pricing-svc/test/historical-initialization.e2e-spec.ts',
  'apps/pricing-svc/test/price-audit.integration.e2e-spec.ts',
  'apps/pricing-svc/test/catalog-pricing.integration.e2e-spec.ts',
];
const legacy = [
  'TAXONOMY-UPDATES:',
  'BLOCK-A2:',
  'JOINT-01:',
  'JOINT-01-REGRESSION:',
  'BULK-JOINT:',
  'BULK-CONSUMER-v2:',
];

function validate(workflow, vitest, source) {
  const e2e = workflow.split('\n  e2e:')[1]?.split('\n  contratos:')[0] ?? '';
  assert.match(e2e, /CATALOG_POSTGRES_ONLY:\s*['"]1['"]/);
  assert.match(e2e, /npm run test:e2e/);
  assert.match(vitest, /process\.env\.CATALOG_POSTGRES_ONLY === '1'/);
  assert.match(source, /const itLegacy = catalogPostgresOnly \? it\.skip : it/);
  for (const file of excluded)
    assert.ok(vitest.includes(`'${file}'`), `missing exclusion: ${file}`);
  assert.match(
    source,
    /if \(!catalogPostgresOnly\) await jointBroker\.start\(\)/,
  );
  assert.equal(
    (source.match(/new DisposableCatalogBroker\(/g) ?? []).length,
    2,
  );
  assert.equal(
    (source.match(/await (?:jointBroker|broker)\.start\(/g) ?? []).length,
    2,
  );
  for (const title of legacy)
    assert.ok(
      new RegExp(`itLegacy\\(\\s*'${title}`).test(source),
      `missing legacy guard: ${title}`,
    );
}
const brokerSignature =
  /new\s+[A-Za-z0-9_]*(?:rabbit|broker)[A-Za-z0-9_]*\s*\(|rabbitmq:[0-9]|isolated-[a-z-]*rabbit|disposable-catalog-broker/i;
function assertClassified(path, contents) {
  if (!brokerSignature.test(contents)) return;
  const safeCatalog =
    path === 'apps/catalog-svc/test/postgres.persistence.e2e-spec.ts';
  const alreadyExcluded =
    excluded.includes(path) || config.includes(`'${path}'`);
  assert.ok(safeCatalog || alreadyExcluded, `unclassified broker E2E: ${path}`);
}
function scan(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name).replaceAll('\\', '/');
    if (entry.isDirectory()) scan(path);
    else if (path.endsWith('.e2e-spec.ts'))
      assertClassified(path, readFileSync(path, 'utf8'));
  }
}
test('un E2E nuevo que menciona un broker debe clasificarse', () => {
  scan('apps');
  scan('tests');
  assert.throws(() =>
    assertClassified('apps/new/test/unknown.e2e-spec.ts', 'new RabbitBroker()'),
  );
});
test('H5 E2E configura selección explícita y separa seis casos AMQP', () =>
  validate(ci, config, catalog));
test('rechaza flags ausentes, exclusiones incompletas y broker sin guarda', () => {
  assert.throws(() =>
    validate(ci.replace("CATALOG_POSTGRES_ONLY: '1'", ''), config, catalog),
  );
  assert.throws(() =>
    validate(ci, config.replace(excluded[0], 'missing'), catalog),
  );
  assert.throws(() =>
    validate(
      ci,
      config,
      catalog.replace(
        'if (!catalogPostgresOnly) await jointBroker.start()',
        'await jointBroker.start()',
      ),
    ),
  );
  assert.throws(() =>
    validate(ci, config, `${catalog}\nnew DisposableCatalogBroker()`),
  );
  assert.throws(() =>
    validate(
      ci,
      config,
      catalog.replace('catalogPostgresOnly ? it.skip : it', 'it'),
    ),
  );
});
