// Executes the previously environment-gated suite against a fresh loopback-only
// PostgreSQL 17 container. Credentials live only in this process and its child.
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';

const exec = promisify(execFile);
const image = 'postgres:17.11@sha256:ff87138949ad9a46f32ff23bd6852b52ce024a13dffe9b4087be98292cdd3b4f';
const name = `g6-bulk-pg17-${randomUUID()}`;
const password = randomBytes(24).toString('hex');
let created = false;
let pool;
try {
  await exec('docker', ['run', '--detach', '--name', name, '--publish', '127.0.0.1::5432', '--env', `POSTGRES_PASSWORD=${password}`, '--env', 'POSTGRES_DB=bulk_test', image], { timeout: 60_000 });
  created = true;
  const { stdout } = await exec('docker', ['port', name, '5432/tcp']);
  const port = /^127\.0\.0\.1:(\d+)\s*$/.exec(stdout)?.[1];
  if (!port) throw new Error('Invalid loopback port for isolated PostgreSQL');
  const adminUrl = `postgresql://postgres:${password}@127.0.0.1:${port}/bulk_test?sslmode=disable`;
  pool = new Pool({ connectionString: adminUrl });
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try { await pool.query('SELECT 1'); ready = true; break; } catch { await delay(250); }
  }
  if (!ready) throw new Error('Isolated PostgreSQL 17 did not become ready');
  await pool.query('CREATE SCHEMA bulk');
  const files = ['test/fixtures/0001_create_bulk_persistence.sql', 'migrations/0002_export_source_snapshot.sql', 'migrations/0003_export_claim_lease.sql', 'migrations/0004_catalog_claim_check_content.sql', 'migrations/0005_actor_ownership.sql', 'migrations/0006_owner_correlation_identity.sql', 'migrations/0007_bulk_retry_v1.sql', 'migrations/0008_h5_outbox_delivery.sql', 'migrations/0009_h5_outbox_delivery_all_destinations.sql'];
  for (const file of files) await pool.query(await readFile(`apps/bulk-svc/${file}`, 'utf8'));
  await pool.query(`CREATE ROLE bulk_test_runtime LOGIN PASSWORD '${password}'; GRANT USAGE ON SCHEMA bulk TO bulk_test_runtime; GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA bulk TO bulk_test_runtime; GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA bulk TO bulk_test_runtime`);
  const env = { ...process.env, NODE_ENV: 'test', BULK_TEST_DATABASE_URL: adminUrl.replace('postgres:', 'bulk_test_runtime:'), BULK_TEST_ADMIN_DATABASE_URL: adminUrl };
  console.log(JSON.stringify({ environment: 'isolated-loopback-postgres17', image, migrations: files }));
  const child = spawn(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', 'apps/bulk-svc/src/persistence/bulk.repository.integration.spec.ts', '--reporter=json', '--outputFile=tests/h5/bulk-postgres17-result.json', ...process.argv.slice(2)], { env, stdio: 'inherit' });
  process.exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code ?? 1)); });
} finally {
  await pool?.end();
  // This name was generated above for this run; no existing container is touched.
  if (created) await exec('docker', ['rm', '--force', '--volumes', name], { timeout: 15_000 });
}
