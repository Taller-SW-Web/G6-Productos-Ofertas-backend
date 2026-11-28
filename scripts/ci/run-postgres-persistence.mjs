import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const vitest = resolve('node_modules/vitest/vitest.mjs');
const evidenceDirectory = resolve('.ci/evidence/postgres-persistence');
mkdirSync(evidenceDirectory, { recursive: true });

const suites = [
  {
    name: 'Pricing PostgreSQL',
    file: 'apps/pricing-svc/test/persistence.e2e-spec.ts',
    enabled: 'PRICING_TEST_POSTGRES',
  },
  {
    name: 'Pricing import PostgreSQL',
    file: 'apps/pricing-svc/test/import-prices.postgres.e2e-spec.ts',
    enabled: 'PRICING_TEST_POSTGRES',
  },
  {
    name: 'Price Audit PostgreSQL',
    file: 'apps/price-audit-svc/test/provider.postgres.e2e-spec.ts',
    enabled: 'PRICE_AUDIT_TEST_POSTGRES',
  },
  {
    name: 'Price Audit exports PostgreSQL',
    file: 'apps/price-audit-svc/test/exports.postgres.e2e-spec.ts',
    enabled: 'PRICE_AUDIT_TEST_POSTGRES',
  },
];

for (const [index, suite] of suites.entries()) {
  const report = resolve(evidenceDirectory, `suite-${index + 1}.json`);
  const env = { ...process.env, [suite.enabled]: '1' };
  for (const flag of [
    'PRICING_TEST_AMQP',
    'PRICING_TEST_AUDIT',
    'PRICE_AUDIT_TEST_AMQP',
  ])
    delete env[flag];

  const result = spawnSync(
    process.execPath,
    [
      vitest,
      'run',
      '--config',
      'vitest.config.e2e.ts',
      suite.file,
      '--reporter=json',
      `--outputFile=${report}`,
    ],
    { env, encoding: 'utf8', stdio: 'inherit' },
  );
  if (result.error) throw result.error;
  const summary = JSON.parse(readFileSync(report, 'utf8'));
  const passed = summary.numPassedTests ?? 0;
  const failed = summary.numFailedTests ?? 0;
  const skipped = summary.numPendingTests ?? 0;
  const total = summary.numTotalTests ?? 0;
  const skippedTitles = summary.testResults.flatMap((file) => file.assertionResults ?? []).filter((item) => item.status === 'skipped').map((item) => item.title);
  const allowedSkipped = suite.file === 'apps/pricing-svc/test/persistence.e2e-spec.ts'
    ? ['mide GET individual HTTP de SKU con PostgreSQL desechable']
    : [];
  console.log(
    `${suite.name}: ${passed} aprobadas, ${failed} fallidas, ${skipped} omitidas, ${total} totales`,
  );
  if (
    result.status !== 0 ||
    passed === 0 ||
    failed !== 0 ||
    total === 0 ||
    skippedTitles.length !== allowedSkipped.length ||
    skippedTitles.some((title) => !allowedSkipped.includes(title))
  )
    throw new Error(`${suite.name} no ejecutó casos reales aprobados`);
}
