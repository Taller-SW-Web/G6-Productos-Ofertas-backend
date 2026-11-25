import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  esperarPostgres,
  acreditarPropiedadContenedor,
  eliminarContenedor,
} from '../../scripts/ci/run-taxonomy-integration.mjs';
import pg from 'pg';

const id = randomBytes(32).toString('hex');
const name = `g6-int06-${randomUUID().slice(0, 18)}`;
const password = randomBytes(24).toString('hex');
const dir = mkdtempSync(join(tmpdir(), 'g6-int06-'));
const docker = (args) => {
  const p = spawnSync('docker', args, {
    encoding: 'utf8',
    timeout: 180000,
    windowsHide: true,
  });
  if (p.error || p.status !== 0) throw new Error(`Docker ${args[0]} failed`);
  return p.stdout.trim();
};
let launched = false;
try {
  if (process.env.TAXONOMY_TEST_DATABASE_URL?.trim())
    throw new Error('External database prohibited');
  docker(['info']);
  launched = true;
  docker([
    'run',
    '--detach',
    '--rm',
    '--name',
    name,
    '--label',
    'com.taller-sw.g6.taxonomy-harness=true',
    '--label',
    `com.taller-sw.g6.taxonomy-harness-id=${id}`,
    '--publish',
    '127.0.0.1::5432',
    '--env',
    `POSTGRES_PASSWORD=${password}`,
    '--env',
    'POSTGRES_DB=taxonomy_test',
    'postgres:17-alpine',
    'postgres',
    '-c',
    `g6.taxonomy_harness_id=${id}`,
  ]);
  await esperarPostgres(name);
  const port = /^127\.0\.0\.1:(\d+)$/.exec(
    docker(['port', name, '5432/tcp']),
  )?.[1];
  if (!port) throw new Error('PostgreSQL port is not loopback');
  const url = `postgresql://postgres:${password}@127.0.0.1:${port}/taxonomy_test`;
  const client = new pg.Client({
    connectionString: url,
    connectionTimeoutMillis: 5000,
  });
  try {
    await client.connect();
    const r = await client.query(
      "SELECT current_setting('g6.taxonomy_harness_id', true) AS id",
    );
    if (r.rows[0]?.id !== id) throw new Error('Harness identity mismatch');
  } finally {
    await client.end();
  }
  const report = join(dir, 'report.json');
  const p = spawnSync(
    process.execPath,
    [
      'node_modules/vitest/vitest.mjs',
      'run',
      '--config',
      'vitest.config.e2e.ts',
      'apps/taxonomy-svc/test/persistencia-drizzle.e2e-spec.ts',
      '--reporter=json',
      `--outputFile=${report}`,
    ],
    {
      encoding: 'utf8',
      timeout: 240000,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
      env: {
        ...process.env,
        TAXONOMY_TEST_DATABASE_URL: url,
        TAXONOMY_TEST_DB_ACK: 'desechable-aislado',
        TAXONOMY_TEST_DB_EPHEMERAL: '1',
        TAXONOMY_TEST_HARNESS_ID: id,
      },
    },
  );
  if (p.error || p.status !== 0)
    throw new Error(`Vitest failed: ${p.error?.code ?? p.status}`);
  const data = JSON.parse(readFileSync(report, 'utf8'));
  if (data.numFailedTests || data.numPendingTests || !data.numPassedTests)
    throw new Error('Incomplete Vitest results');
  const assertions = data.testResults.flatMap((f) =>
    f.assertionResults.map((t) => ({ title: t.title, status: t.status })),
  );
  console.log(
    JSON.stringify({
      tests_passed: data.numPassedTests,
      tests_total: data.numTotalTests,
      assertions,
    }),
  );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (launched) {
    const owned = acreditarPropiedadContenedor(name, id);
    const r = eliminarContenedor(name, id, spawnSync, owned);
    if (!r.ok) {
      console.error('Harness cleanup failed');
      process.exitCode = 1;
    }
  }
  rmSync(dir, { recursive: true, force: true });
}
