import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import pg from 'pg';

const name = `g6-taxonomy-migration-${randomUUID()}`;
const password = randomUUID();
const migration = readFileSync(
  'apps/taxonomy-svc/migrations/0006_service_bus_outbox_delivery.sql',
  'utf8',
);
const candidate = readFileSync(
  'apps/taxonomy-svc/migrations-candidate/h5/0001_outbox_delivery.sql',
  'utf8',
);
const docker = (...args) =>
  execFileSync('docker', args, {
    encoding: 'utf8',
    timeout: 120000,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  }).trim();
let id;
let db;
const query = (...args) => db.query(...args);
async function reset() {
  await query('RESET ROLE');
  await query('DROP SCHEMA IF EXISTS taxonomy CASCADE');
  await query('CREATE SCHEMA taxonomy AUTHORIZATION po_taxonomy_owner');
  await query('SET ROLE po_taxonomy_owner');
  await query(
    'CREATE TABLE taxonomy.outbox (message_id uuid PRIMARY KEY, event_name text NOT NULL)',
  );
  await query('GRANT USAGE ON SCHEMA taxonomy TO taxonomy_app');
  await query('GRANT SELECT,INSERT ON taxonomy.outbox TO taxonomy_app');
}
async function install(sql) {
  await query('BEGIN');
  try {
    await query(sql);
    await query('COMMIT');
  } catch (e) {
    await query('ROLLBACK');
    throw e;
  }
}
async function runtimeInsert(id) {
  await query('SET ROLE taxonomy_app');
  try {
    return await query(
      "INSERT INTO taxonomy.outbox(message_id,event_name,delivery_transport) VALUES ($1,'taxonomy.category.updated','AZURE_SERVICE_BUS')",
      [id],
    );
  } finally {
    await query('RESET ROLE');
  }
}
try {
  id = docker(
    'run',
    '--detach',
    '--rm',
    '--name',
    name,
    '--publish',
    '127.0.0.1::5432',
    '--env',
    `POSTGRES_PASSWORD=${password}`,
    '--env',
    'POSTGRES_DB=taxonomy_0006_test',
    'postgres:17-alpine',
  );
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('INVALID_CONTAINER_ID');
  const port = /^127\.0\.0\.1:(\d+)$/.exec(docker('port', id, '5432/tcp'))?.[1];
  if (!port) throw new Error('INVALID_LOOPBACK');
  for (let i = 0; i < 60; i++) {
    try {
      docker(
        'exec',
        id,
        'pg_isready',
        '-U',
        'postgres',
        '-d',
        'taxonomy_0006_test',
      );
      break;
    } catch {
      if (i === 59) throw new Error('POSTGRES_NOT_READY');
      await delay(500);
    }
  }
  db = new pg.Client({
    host: '127.0.0.1',
    port: Number(port),
    database: 'taxonomy_0006_test',
    user: 'postgres',
    password,
  });
  await db.connect();
  await query(
    'CREATE ROLE po_taxonomy_owner NOLOGIN; CREATE ROLE taxonomy_app NOLOGIN; CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN',
  );
  await reset();
  await install(migration);
  assert.equal(
    (
      await query(
        "SELECT NOT prosecdef AS invoker FROM pg_proc WHERE oid='taxonomy.fn_enqueue_catalog_h5()'::regprocedure",
      )
    ).rows[0].invoker,
    true,
  );
  console.log('SQL-CLEAN PASS');
  await reset();
  await install(candidate);
  await query(
    'GRANT UPDATE (destination) ON taxonomy.outbox_delivery TO taxonomy_app, anon, authenticated, PUBLIC',
  );
  const upgraded = randomUUID();
  await runtimeInsert(upgraded);
  await query('SET ROLE po_taxonomy_owner');
  await install(migration);
  for (const role of ['taxonomy_app', 'anon', 'authenticated']) {
    const { rows } = await query(
      "SELECT has_column_privilege($1, 'taxonomy.outbox_delivery', 'destination', 'UPDATE') AS allowed",
      [role],
    );
    assert.equal(rows[0].allowed, false, `${role} must not update destination`);
  }
  assert.equal(
    Number(
      (
        await query(
          'SELECT count(*) AS n FROM taxonomy.outbox_delivery WHERE message_id=$1',
          [upgraded],
        )
      ).rows[0].n,
    ),
    1,
  );
  console.log('SQL-UPGRADE PASS');
  const idRole = randomUUID();
  await runtimeInsert(idRole);
  assert.equal(
    Number(
      (
        await query(
          'SELECT count(*) AS n FROM taxonomy.outbox_delivery WHERE message_id=$1',
          [idRole],
        )
      ).rows[0].n,
    ),
    1,
  );
  console.log('SQL-ROLE PASS');
  await query('SET ROLE po_taxonomy_owner');
  await query('REVOKE INSERT ON taxonomy.outbox_delivery FROM taxonomy_app');
  const denied = randomUUID();
  await assert.rejects(runtimeInsert(denied), (e) => e.code === '42501');
  assert.equal(
    Number(
      (
        await query(
          'SELECT count(*) AS n FROM taxonomy.outbox WHERE message_id=$1',
          [denied],
        )
      ).rows[0].n,
    ),
    0,
  );
  await query('GRANT INSERT ON taxonomy.outbox_delivery TO taxonomy_app');
  console.log('SQL-NO-GRANT PASS');
  await reset();
  const historic = randomUUID();
  await query(
    "INSERT INTO taxonomy.outbox(message_id,event_name) VALUES ($1,'taxonomy.category.updated')",
    [historic],
  );
  await install(migration);
  assert.equal(
    Number(
      (
        await query(
          'SELECT count(*) AS n FROM taxonomy.outbox_delivery WHERE message_id=$1',
          [historic],
        )
      ).rows[0].n,
    ),
    0,
  );
  console.log('SQL-HISTORICAL PASS');
  await reset();
  await query(
    'CREATE TABLE taxonomy.outbox_delivery(message_id uuid PRIMARY KEY)',
  );
  await assert.rejects(
    install(migration),
    /TAXONOMY_H5_DELIVERY_PK_INCOMPATIBLE/,
  );
  await reset();
  await install(candidate);
  await query(
    'ALTER FUNCTION taxonomy.fn_enqueue_catalog_h5() SECURITY DEFINER',
  );
  await assert.rejects(install(migration), /TAXONOMY_H5_FUNCTION_INCOMPATIBLE/);
  await reset();
  await install(candidate);
  await query(
    `CREATE FUNCTION taxonomy.alternate_writer() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO taxonomy.outbox_delivery(message_id,destination) VALUES (NEW.message_id,'g6.catalog.from.taxonomy'); RETURN NEW; END $$`,
  );
  await query(
    'CREATE TRIGGER alternate_writer AFTER INSERT ON taxonomy.outbox FOR EACH ROW EXECUTE FUNCTION taxonomy.alternate_writer()',
  );
  await assert.rejects(install(migration), /TAXONOMY_H5_ALTERNATE_WRITER/);
  await reset();
  await install(candidate);
  await query(
    'ALTER TABLE taxonomy.outbox_delivery ALTER COLUMN lease_token TYPE text USING lease_token::text',
  );
  await assert.rejects(install(migration), /TAXONOMY_H5_COLUMN_INCOMPATIBLE/);
  console.log(
    'SQL-CONFLICT PASS (PK, SECURITY DEFINER, alternate trigger, column type)',
  );
  await reset();
  await install(migration);
  const rid = randomUUID();
  await runtimeInsert(rid);
  await query('SET ROLE po_taxonomy_owner');
  const old = randomUUID(),
    fresh = randomUUID();
  await query(
    'UPDATE taxonomy.outbox_delivery SET lease_token=$2,lease_until=now() WHERE message_id=$1',
    [rid, old],
  );
  await query(
    "UPDATE taxonomy.outbox_delivery SET lease_token=$2,lease_until=now()+interval '1 minute' WHERE message_id=$1",
    [rid, fresh],
  );
  assert.equal(
    (
      await query(
        'UPDATE taxonomy.outbox_delivery SET sent_at=now() WHERE message_id=$1 AND lease_token=$2',
        [rid, old],
      )
    ).rowCount,
    0,
  );
  assert.equal(
    Number(
      (
        await query(
          'SELECT count(*) AS n FROM taxonomy.outbox_delivery WHERE message_id=$1',
          [rid],
        )
      ).rows[0].n,
    ),
    1,
  );
  console.log('SQL-REDELIVERY PASS');
} catch (e) {
  console.error('SQL_TEST_FAIL', e.code, e.message, e.where);
  process.exitCode = 1;
} finally {
  if (db) await db.end().catch(() => {});
  if (id && /^[a-f0-9]{64}$/.test(id)) {
    try {
      docker('stop', id);
    } catch {
      console.error('OWN_CONTAINER_CLEANUP_FAILED');
      process.exitCode = 1;
    }
  }
}
