import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const file = 'apps/catalog-svc/test/postgres.persistence.e2e-spec.ts';
const evidenceDirectory = resolve('.ci/evidence/catalog-postgres-ci');
mkdirSync(evidenceDirectory, { recursive: true });
const sha = process.env.GITHUB_SHA ?? 'local';
const report = resolve(evidenceDirectory, `catalog-postgres-${sha}.json`);
const metadataReport = resolve(
  evidenceDirectory,
  `catalog-postgres-${sha}-coverage.json`,
);
const expectedTitles = [
  'creates simple and variant products atomically with the correct preparation and Outbox intents',
  'rolls back operation failures and reports deferred aggregate constraints at commit',
  'persists the exact product deactivation event once under concurrent retries',
  'reads contractual preparation, variants and physical SKU data from the committed aggregate',
];
const testNamePattern = expectedTitles
  .map((title) => title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  .join('|');
const env = { ...process.env, CI: 'true', G6_CATALOG_POSTGRES_CI: '1' };
for (const key of Object.keys(env))
  if (/^(?:RABBITMQ|AMQP|CATALOG_AMQP)/i.test(key)) delete env[key];

const result = spawnSync(
  process.execPath,
  [
    resolve('node_modules/vitest/vitest.mjs'),
    'run',
    '--config',
    'vitest.config.e2e.ts',
    file,
    '--reporter=json',
    `--outputFile=${report}`,
    `--testNamePattern=${testNamePattern}`,
  ],
  { env, encoding: 'utf8', stdio: 'inherit' },
);
if (result.error) throw result.error;
if (!readFileSync(report, 'utf8'))
  throw new Error('Catalog PostgreSQL suite did not produce JSON evidence');
const summary = JSON.parse(readFileSync(report, 'utf8'));
const assertions = summary.testResults.flatMap((suite) =>
  suite.assertionResults.map((test) => ({
    title: test.title,
    status: test.status,
  })),
);
const passedTitles = new Set(
  assertions.filter((test) => test.status === 'passed').map((test) => test.title),
);
const missing = expectedTitles.filter((title) => !passedTitles.has(title));
writeFileSync(
  metadataReport,
  JSON.stringify(
    {
      sha,
      classification: 'COBERTURA_PARCIAL',
      originalHistoricalSuiteCases: 47,
      fullOriginalHistoricalSuiteExecuted: false,
      selectedPostgresOnlyCases: expectedTitles,
      passedTitles: [...passedTitles],
      report,
      counts: {
        passed: summary.numPassedTests ?? 0,
        failed: summary.numFailedTests ?? 0,
        skipped: summary.numPendingTests ?? 0,
        total: summary.numTotalTests ?? 0,
      },
      rabbitMqStarted: false,
    },
    null,
    2,
  ) + '\n',
);
console.log(
  `Catalog PostgreSQL parcial (4 casos seleccionados; suite histórica original de 47 casos no ejecutada): ${summary.numPassedTests ?? 0} aprobadas, ${summary.numFailedTests ?? 0} fallidas, ${summary.numPendingTests ?? 0} omitidas, ${summary.numTotalTests ?? 0} totales; SHA ${sha}`,
);
if (
  result.status !== 0 ||
  (summary.numPassedTests ?? 0) < expectedTitles.length ||
  (summary.numFailedTests ?? 0) !== 0 ||
  missing.length > 0
)
  throw new Error(
    `Catalog PostgreSQL CI coverage incomplete; missing passing cases: ${missing.join(', ') || 'none'}`,
  );
