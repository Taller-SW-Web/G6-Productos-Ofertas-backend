// Disposable loopback PostgreSQL only; never reads deployment DB configuration.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { setTimeout } from 'node:timers/promises';
import { Pool } from 'pg';

const exec = promisify(execFile);
const name = `bulk-admission-${randomUUID()}`;
const image =
  'postgres:17-alpine@sha256:f9cf3e1f0066f0eb0c48707d864f0ac5941e9ff454a072077d97a4d278d07d73';
const password = randomUUID();
let created = false;
let pool;
try {
  await exec('docker', ['pull', image], { timeout: 180_000 });
  const inspected = await exec('docker', [
    'image',
    'inspect',
    image,
    '--format',
    '{{index .RepoDigests 0}}',
  ]);
  console.log(`PostgreSQL fixture: ${inspected.stdout.trim()}`);
  await exec(
    'docker',
    [
      'run',
      '--detach',
      '--rm',
      '--name',
      name,
      '--publish',
      '127.0.0.1::5432',
      '--env',
      'POSTGRES_PASSWORD',
      '--env',
      'POSTGRES_DB=bulk_test',
      image,
    ],
    {
      env: { ...process.env, POSTGRES_PASSWORD: password },
      timeout: 60_000,
    },
  );
  created = true;
  const ports = await exec('docker', ['port', name, '5432/tcp']);
  const port = /^127\.0\.0\.1:(\d+)\s*$/.exec(ports.stdout)?.[1];
  if (!port) throw new Error('Disposable database must bind to loopback.');
  const url = `postgresql://postgres:${password}@127.0.0.1:${port}/bulk_test?sslmode=disable`;
  pool = new Pool({ connectionString: url, max: 2 });
  for (let attempt = 0; ; attempt++) {
    try {
      await pool.query('SELECT 1');
      break;
    } catch {
      if (attempt >= 60)
        throw new Error('Disposable PostgreSQL readiness failed.');
      await setTimeout(250);
    }
  }
  await pool.query('CREATE SCHEMA bulk');
  const files = [
    './fixtures/0001_create_bulk_persistence.sql',
    '../migrations/0002_export_source_snapshot.sql',
    '../migrations/0003_export_claim_lease.sql',
    '../migrations/0004_catalog_claim_check_content.sql',
    '../migrations/0005_actor_ownership.sql',
    '../migrations/0006_owner_correlation_identity.sql',
    '../migrations/0007_bulk_retry_v1.sql',
    '../migrations/0008_h5_outbox_delivery.sql',
    '../migrations/0009_h5_outbox_delivery_all_destinations.sql',
    '../migrations/0010_import_admission_invariant.sql',
  ];
  for (const file of files)
    await pool.query(await readFile(new URL(file, import.meta.url), 'utf8'));
  await pool.end();
  pool = undefined;
  const testEnvironment = {
    ...process.env,
    NODE_ENV: 'test',
    BULK_TEST_DATABASE_URL: url,
  };
  delete testEnvironment.BULK_TEST_ADMIN_DATABASE_URL;
  const result = await exec(
    process.execPath,
    [
      'node_modules/vitest/vitest.mjs',
      'run',
      'apps/bulk-svc/src/persistence/bulk.repository.integration.spec.ts',
      '--maxWorkers=1',
      '--reporter=verbose',
    ],
    {
      env: testEnvironment,
      timeout: 300_000,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
} catch (error) {
  // Never print command/env/connection strings from child-process exceptions.
  if (error && typeof error === 'object' && 'stdout' in error)
    process.stdout.write(String(error.stdout));
  if (error && typeof error === 'object' && 'stderr' in error)
    process.stderr.write(String(error.stderr));
  console.error('Disposable Bulk admission regression failed.');
  process.exitCode = 1;
} finally {
  await pool?.end();
  if (created)
    await exec('docker', ['rm', '--force', '--volumes', name], {
      timeout: 15_000,
    });
}
