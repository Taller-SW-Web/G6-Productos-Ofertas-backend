import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { resolve } from 'node:path';
import pg from 'pg';
import { officialMigrations } from '../../../../apps/promotions-svc/test/support/official-migrations.mjs';

const { Pool } = pg;
const root = resolve(import.meta.dirname, '../../../..');
const runId = randomUUID().replaceAll('-', '').slice(0, 12);
const container = `g6-h04-bootstrap-${runId}`;
const label = 'g6.h5.h04-bootstrap';
const dbName = `g6_h04_${runId}`;
const adminPassword = randomBytes(32).toString('base64url');
const runtimePasswords = Object.fromEntries(
  ['catalog_app', 'inventory_app', 'pricing_app', 'promotions_app'].map(
    (role) => [role, randomBytes(32).toString('base64url')],
  ),
);
let created = false;
let pool;
let port;

function docker(args, options = {}) {
  try {
    return execFileSync('docker', args, {
      encoding: 'utf8',
      stdio: 'pipe',
      ...options,
    }).trim();
  } catch {
    throw new Error(`DOCKER_${args[0]?.toUpperCase() ?? 'COMMAND'}_FAILED`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function sqlFile(path) {
  return readFile(resolve(root, path), 'utf8');
}

async function asRole(role, sql) {
  const client = await pool.connect();
  let operationError;
  let restorationError;
  let originalContext;
  try {
    originalContext = (
      await client.query(
        'SELECT current_user AS current_user, session_user AS session_user',
      )
    ).rows[0];
    await client.query(`SET ROLE ${role}`);
    const effective = await client.query(
      'SELECT current_user AS current_user, session_user AS session_user',
    );
    assert(
      effective.rows[0].current_user === role,
      `SET_ROLE_IDENTITY_MISMATCH:${role}`,
    );
    await client.query(sql);
  } catch (error) {
    operationError = error;
  }
  try {
    await client.query('ROLLBACK');
    await client.query('RESET ROLE');
    const restored = await client.query(
      'SELECT current_user AS current_user, session_user AS session_user',
    );
    assert(
      restored.rows[0].current_user === originalContext.current_user &&
        restored.rows[0].session_user === originalContext.session_user,
      'ROLE_CONTEXT_RESTORE_FAILED',
    );
  } catch (error) {
    restorationError = error;
  }
  if (restorationError) {
    client.release(restorationError);
    if (operationError instanceof Error)
      Object.defineProperty(operationError, 'roleRestorationError', {
        value: restorationError,
      });
  } else {
    client.release();
  }
  if (operationError) throw operationError;
  if (restorationError) throw restorationError;
}

function runtimePool(user) {
  return new Pool({
    host: '127.0.0.1',
    port,
    user,
    password: runtimePasswords[user],
    database: dbName,
    max: 1,
  });
}

async function expectDenied(client, sql, expectedCode = '42501') {
  try {
    await client.query(sql);
    throw new Error('PROHIBITED_SQL_UNEXPECTEDLY_SUCCEEDED');
  } catch (error) {
    if (error.message === 'PROHIBITED_SQL_UNEXPECTEDLY_SUCCEEDED') throw error;
    assert(error.code === expectedCode, `UNEXPECTED_DENIAL_CODE:${error.code}`);
  }
}
try {
  docker([
    'run',
    '--detach',
    '--rm',
    '--name',
    container,
    '--label',
    `${label}=${runId}`,
    '--publish',
    '127.0.0.1::5432',
    '--env',
    `POSTGRES_PASSWORD=${adminPassword}`,
    '--env',
    'POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256 --auth-local=scram-sha-256',
    '--env',
    `POSTGRES_DB=${dbName}`,
    'postgres:17.11',
    'postgres',
    '-c',
    'password_encryption=scram-sha-256',
  ]);
  created = true;
  const published = docker(['port', container, '5432/tcp']);
  const match = /^127\.0\.0\.1:(\d+)$/.exec(published);
  assert(match, 'PostgreSQL port was not bound exclusively to loopback');
  port = Number(match[1]);
  const admin = new Pool({
    host: '127.0.0.1',
    port,
    user: 'postgres',
    password: adminPassword,
    database: dbName,
    max: 1,
  });
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      await admin.query('SELECT 1');
      break;
    } catch (error) {
      if (attempt === 59) throw error;
      await delay(250);
    }
  }
  const version = Number(
    (await admin.query('SHOW server_version_num')).rows[0].server_version_num,
  );
  assert(
    version >= 170000 && version < 180000,
    `Expected PostgreSQL 17, got ${version}`,
  );

  const runtimeRoleSql = Object.entries(runtimePasswords)
    .map(
      ([role, password]) =>
        `CREATE ROLE ${role} LOGIN INHERIT PASSWORD '${password}';`,
    )
    .join('\n');
  assert(
    [adminPassword, ...Object.values(runtimePasswords)].every((password) =>
      /^[A-Za-z0-9_-]+$/.test(password),
    ),
    'GENERATED_CREDENTIAL_FORMAT_UNEXPECTED',
  );
  await admin.query(`
    CREATE ROLE po_catalog_owner NOLOGIN;
    CREATE ROLE po_inventory_owner NOLOGIN;
    CREATE ROLE po_inventory_runtime NOLOGIN;
    CREATE ROLE po_pricing_owner NOLOGIN;
    CREATE ROLE po_promotions_owner NOLOGIN;
    CREATE ROLE po_promotions_runtime NOLOGIN;
    ${runtimeRoleSql}
    GRANT po_inventory_runtime TO inventory_app;
    GRANT po_promotions_runtime TO promotions_app;
    CREATE SCHEMA catalog AUTHORIZATION po_catalog_owner;
    CREATE SCHEMA pricing AUTHORIZATION po_pricing_owner;
    CREATE SCHEMA promotions AUTHORIZATION po_promotions_owner;
    CREATE SCHEMA extensions;
    CREATE EXTENSION btree_gist WITH SCHEMA extensions;
    GRANT USAGE ON SCHEMA extensions TO po_pricing_owner;
    REVOKE CREATE ON SCHEMA public FROM PUBLIC;
  `);
  const scramCheck = await admin.query(
    `SELECT
    current_setting('password_encryption') = 'scram-sha-256' AS configured,
    bool_and(rolpassword LIKE 'SCRAM-SHA-256$%') AS credentials_are_scram
    FROM pg_authid WHERE rolname = ANY($1::text[])`,
    [['postgres', ...Object.keys(runtimePasswords)]],
  );
  assert(
    scramCheck.rows[0].configured && scramCheck.rows[0].credentials_are_scram,
    'SCRAM_AUTHENTICATION_NOT_ACTIVE',
  );
  pool = admin;

  await asRole(
    'po_catalog_owner',
    await sqlFile('apps/catalog-svc/test/fixtures/0001_create_catalog.sql'),
  );
  await admin.query(
    `GRANT CREATE ON DATABASE "${dbName}" TO po_inventory_owner`,
  );
  await asRole(
    'po_inventory_owner',
    await sqlFile('apps/catalog-svc/test/fixtures/inventory-initial.sql'),
  );
  await asRole(
    'po_inventory_owner',
    await sqlFile('apps/catalog-svc/test/fixtures/inventory-operations.sql'),
  );
  await admin.query(
    `REVOKE CREATE ON DATABASE "${dbName}" FROM po_inventory_owner`,
  );
  await asRole(
    'po_inventory_owner',
    await sqlFile(
      'apps/inventory-svc/migrations/20261104_0001_lifecycle_offline_reconciliation.sql',
    ),
  );

  const pricingDdl = await sqlFile(
    'apps/pricing-svc/test/fixtures/pricing.sql',
  );
  await admin.query(
    `BEGIN; SET LOCAL ROLE po_pricing_owner; ${pricingDdl}; COMMIT;`,
  );
  await admin.query('GRANT USAGE ON SCHEMA inventory TO po_inventory_runtime');
  await admin.query(`GRANT SELECT ON inventory.locations, inventory.stock_balance,
    inventory.commercial_fulfillment_routes, inventory.sku_lifecycle TO po_inventory_runtime`);
  await admin.query(
    `GRANT SELECT ON catalog.sku_identity TO po_inventory_runtime`,
  );

  const promoMigrations = await officialMigrations();
  for (const migration of promoMigrations)
    await asRole('po_promotions_owner', migration);
  await asRole(
    'po_promotions_owner',
    await sqlFile(
      'apps/promotions-svc/migrations-candidate/h5/0001_coupon_http_operations.sql',
    ),
  );
  await asRole(
    'po_promotions_owner',
    `SELECT set_config('g6.promotions_h5_runtime_role','po_promotions_runtime',true);\n${await sqlFile('apps/promotions-svc/migrations-candidate/h5/0002_coupon_http_runtime_role.sql')}`,
  );
  await asRole(
    'po_promotions_owner',
    'CREATE TABLE promotions.h04_future_privilege_probe(id integer)',
  );

  // Only synthetic seed writes use the bootstrap owner connection. Commercial operations are not simulated here.
  await admin.query(
    await sqlFile(
      'ops/supabase/g5-fixtures/tests/local-inventory-lifecycle-fixtures.sql',
    ),
  );
  await admin.query(`INSERT INTO inventory.sku_lifecycle(sku_id, product_id, sku_version, active, changed_at)
    VALUES ('G5F-SIMPLE-001','10000000-0000-4000-8000-000000000001',5,true,'2026-11-20T12:00:00Z'),
           ('G5F-BASE-002','10000000-0000-4000-8000-000000000002',7,false,'2026-11-20T12:10:00Z'),
           ('G5F-VARIANT-002-A','10000000-0000-4000-8000-000000000002',4,true,'2026-11-20T12:30:00Z')`);
  await admin.query(`INSERT INTO inventory.commercial_fulfillment_routes(channel_id,mode,fulfillment_ref,location_id)
    VALUES ('MARKETPLACE','RETIRO_TIENDA','G5F-LOCAL-01','60000000-0000-4000-8000-000000000001')`);
  const pricingSeed = await admin.connect();
  try {
    await pricingSeed.query('BEGIN');
    await pricingSeed.query(`INSERT INTO pricing.prices(id,product_id,sku,channel_id,price_version)
      VALUES ('70000000-0000-4000-8000-000000000001',NULL,'G5F-SIMPLE-001','MARKETPLACE',1)`);
    await pricingSeed.query(`INSERT INTO pricing.price_validities(id,price_id,price_version,precio_regular,precio_oferta,currency,valid_from,valid_until,motivo_cambio)
      VALUES ('71000000-0000-4000-8000-000000000001','70000000-0000-4000-8000-000000000001',1,79.90,NULL,'PEN','2026-11-01T00:00:00Z','2026-12-01T00:00:00Z','fixture integrada local')`);
    await pricingSeed.query('COMMIT');
  } catch (error) {
    await pricingSeed.query('ROLLBACK');
    throw error;
  } finally {
    pricingSeed.release();
  }
  const promotionId = '80000000-0000-4000-8000-000000000001';
  const promotionSeed = await admin.connect();
  try {
    await promotionSeed.query('BEGIN');
    await promotionSeed.query(
      `INSERT INTO promotions.promotions(id,name,discount_type,discount_value,modality,state,valid_from,valid_until,priority,enabled_channels)
      VALUES ($1,'Synthetic H04 coupon','PORCENTAJE',10,'CUPON','ACTIVO','2026-11-01T00:00:00Z','2026-12-01T00:00:00Z',1,ARRAY['MARKETPLACE'])`,
      [promotionId],
    );
    await promotionSeed.query(
      `INSERT INTO promotions.promotion_scopes(promotion_id,sku) VALUES ($1,'G5F-SIMPLE-001')`,
      [promotionId],
    );
    await promotionSeed.query(
      'INSERT INTO promotions.combination_policy VALUES ($1,false,false,false)',
      [promotionId],
    );
    await promotionSeed.query(
      `INSERT INTO promotions.coupons(promotion_id,code,state,max_global_uses,cancellation_policy)
      VALUES ($1,'G5F-H04-COUPON','ACTIVO',20,'RESTAURAR_EN_CANCELACION')`,
      [promotionId],
    );
    await promotionSeed.query('COMMIT');
  } catch (error) {
    await promotionSeed.query('ROLLBACK');
    throw error;
  } finally {
    promotionSeed.release();
  }

  const assertions = await admin.query(`
    SELECT (SELECT count(*) FROM catalog.sku_identity WHERE sku='G5F-SIMPLE-001')=1 AS catalog_identity,
      (SELECT count(*) FROM inventory.sku_lifecycle WHERE sku_id='G5F-SIMPLE-001' AND product_id='10000000-0000-4000-8000-000000000001' AND sku_version=5 AND active)=1 AS lifecycle,
      (SELECT count(*) FROM inventory.stock_balance WHERE sku_id='G5F-SIMPLE-001' AND available=5)=1 AS stock,
      (SELECT count(*) FROM inventory.commercial_fulfillment_routes WHERE channel_id='MARKETPLACE' AND mode='RETIRO_TIENDA' AND fulfillment_ref='G5F-LOCAL-01')=1 AS route,
      (SELECT count(*) FROM pricing.prices p JOIN pricing.price_validities v ON v.price_id=p.id AND v.price_version=p.price_version WHERE p.sku='G5F-SIMPLE-001' AND p.channel_id='MARKETPLACE' AND v.currency='PEN')=1 AS price,
      (SELECT count(*) FROM promotions.coupons WHERE code='G5F-H04-COUPON')=1 AS coupon
  `);
  assert(
    Object.values(assertions.rows[0]).every(Boolean),
    'Coherent fixture assertion failed',
  );

  const probes = [
    [
      'catalog_app',
      "SELECT sku FROM catalog.sku_identity WHERE sku='G5F-SIMPLE-001'",
    ],
    [
      'inventory_app',
      "SELECT sku_id FROM inventory.sku_lifecycle WHERE sku_id='G5F-SIMPLE-001'",
    ],
    [
      'pricing_app',
      "SELECT sku FROM pricing.prices WHERE sku='G5F-SIMPLE-001'",
    ],
    [
      'promotions_app',
      "SELECT code FROM promotions.coupons WHERE code='G5F-H04-COUPON'",
    ],
  ];
  for (const [user, sql] of probes) {
    const runtime = runtimePool(user);
    try {
      assert(
        (await runtime.query(sql)).rowCount === 1,
        `${user} runtime read failed`,
      );
    } finally {
      await runtime.end();
    }
  }
  const promotionsRuntime = runtimePool('promotions_app');
  try {
    const h5Privileges = await promotionsRuntime.query(`SELECT
      bool_and(has_table_privilege(current_user, table_name, 'SELECT')) AS can_select,
      bool_and(has_table_privilege(current_user, table_name, 'INSERT')) AS can_insert,
      bool_and(has_table_privilege(current_user, table_name, 'UPDATE')) AS can_update,
      bool_and(NOT has_table_privilege(current_user, table_name, 'DELETE')) AS no_delete,
      bool_and(NOT has_table_privilege(current_user, table_name, 'TRUNCATE')) AS no_truncate,
      bool_and(NOT has_table_privilege(current_user, table_name, 'REFERENCES')) AS no_references,
      bool_and(NOT has_table_privilege(current_user, table_name, 'TRIGGER')) AS no_trigger,
      bool_and(NOT has_table_privilege(current_user, table_name, 'MAINTAIN')) AS no_maintain
      FROM unnest(ARRAY['promotions.h5_coupon_operations','promotions.h5_coupon_outbox']) AS tables(table_name)`);
    assert(
      Object.values(h5Privileges.rows[0]).every(Boolean),
      'H5_PROMOTIONS_RUNTIME_PRIVILEGES_MISMATCH',
    );
    const schemaPrivileges = await promotionsRuntime.query(`SELECT
      has_schema_privilege(current_user,'promotions','USAGE') AS usage,
      has_schema_privilege(current_user,'promotions','CREATE') AS create_schema,
      has_table_privilege(current_user,'promotions.h04_future_privilege_probe','SELECT') AS future_select,
      has_table_privilege(current_user,'promotions.h04_future_privilege_probe','INSERT') AS future_insert,
      has_table_privilege(current_user,'promotions.h04_future_privilege_probe','UPDATE') AS future_update,
      has_table_privilege(current_user,'promotions.h04_future_privilege_probe','DELETE') AS future_delete,
      has_table_privilege(current_user,'promotions.coupons','DELETE') AS historical_coupon_delete`);
    assert(
      schemaPrivileges.rows[0].usage &&
        !schemaPrivileges.rows[0].create_schema &&
        !schemaPrivileges.rows[0].future_select &&
        !schemaPrivileges.rows[0].future_insert &&
        !schemaPrivileges.rows[0].future_update &&
        !schemaPrivileges.rows[0].future_delete &&
        schemaPrivileges.rows[0].historical_coupon_delete,
      'PROMOTIONS_BASELINE_OR_FUTURE_PRIVILEGES_CHANGED',
    );

    const operationId = randomUUID();
    const messageId = randomUUID();
    await promotionsRuntime.query('BEGIN');
    await promotionsRuntime.query(
      `INSERT INTO promotions.h5_coupon_operations
        (operation_id,message_id,source_client_id,order_id,operation_type,request_fingerprint,command)
       VALUES ($1,$2,'modulo-ventas','PED-H04-ACL','CONSUMIR_CUPON',$3,'{}'::jsonb)`,
      [operationId, messageId, 'a'.repeat(64)],
    );
    await promotionsRuntime.query(
      `UPDATE promotions.h5_coupon_operations
       SET status='COMPLETED', completed_at=clock_timestamp(), result_payload='{}'::jsonb
       WHERE operation_id=$1`,
      [operationId],
    );
    await promotionsRuntime.query(
      `INSERT INTO promotions.h5_coupon_outbox(message_id,operation_id,destination)
       VALUES ($1,$2,'g6.promotions.commands')`,
      [messageId, operationId],
    );
    await promotionsRuntime.query(
      'UPDATE promotions.h5_coupon_outbox SET attempts=1 WHERE operation_id=$1',
      [operationId],
    );
    assert(
      (
        await promotionsRuntime.query(
          'SELECT status FROM promotions.h5_coupon_operations WHERE operation_id=$1',
          [operationId],
        )
      ).rows[0].status === 'COMPLETED' &&
        (
          await promotionsRuntime.query(
            'SELECT attempts FROM promotions.h5_coupon_outbox WHERE operation_id=$1',
            [operationId],
          )
        ).rows[0].attempts === 1,
      'PROMOTIONS_H5_RUNTIME_SELECT_INSERT_UPDATE_FAILED',
    );
    await promotionsRuntime.query('ROLLBACK');

    await expectDenied(
      promotionsRuntime,
      'DELETE FROM promotions.h5_coupon_operations WHERE false',
    );
    await expectDenied(
      promotionsRuntime,
      'TRUNCATE promotions.h5_coupon_operations',
    );
    await expectDenied(
      promotionsRuntime,
      'CREATE TABLE promotions.h04_runtime_forbidden(id integer)',
    );
  } finally {
    await promotionsRuntime.end();
  }
  for (const [user, schema] of [
    ['catalog_app', 'inventory'],
    ['inventory_app', 'pricing'],
    ['pricing_app', 'promotions'],
    ['promotions_app', 'catalog'],
  ]) {
    const runtime = runtimePool(user);
    try {
      await expectDenied(
        runtime,
        `SELECT * FROM ${schema}.${schema === 'catalog' ? 'sku_identity' : schema === 'inventory' ? 'stock_balance' : schema === 'pricing' ? 'prices' : 'coupons'} LIMIT 0`,
      );
    } finally {
      await runtime.end();
    }
  }
  const ddlRoleCheck = await admin.query(
    `SELECT bool_and(NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls) AS safe FROM pg_roles WHERE rolname IN ('catalog_app','inventory_app','pricing_app','promotions_app')`,
  );
  assert(
    ddlRoleCheck.rows[0].safe,
    'A runtime role has administrative PostgreSQL flags',
  );
  await admin.query('DROP TABLE promotions.h04_future_privilege_probe');

  let scopedFailure;
  try {
    await asRole('po_promotions_owner', 'SELECT 1 / 0');
  } catch (error) {
    scopedFailure = error;
  }
  assert(
    scopedFailure?.code === '22012',
    'SET_ROLE_NEGATIVE_PROBE_DID_NOT_FAIL',
  );
  const afterFailure = await pool.query(
    'SELECT current_user AS current_user, session_user AS session_user',
  );
  assert(
    afterFailure.rows[0].current_user === 'postgres' &&
      afterFailure.rows[0].session_user === 'postgres',
    'FAILED_SET_ROLE_BLOCK_LEAKED_PRIVILEGES_TO_NEXT_OPERATION',
  );

  if (process.env.G6_H04_INJECT_FAILURE === 'after-seed')
    throw new Error('INJECTED_H04_CLEANUP_FAILURE_PROBE');

  console.log(
    JSON.stringify(
      {
        result: 'PASS',
        increment: 1,
        postgresMajor: 17,
        schemas: ['catalog', 'inventory', 'pricing', 'promotions'],
        separateRuntimePrincipals: true,
        coherentSyntheticFixture: true,
        allowedReads: 4,
        crossSchemaDenials: 4,
        promotionsH5SelectInsertUpdate: true,
        promotionsH5ForbiddenPrivileges: true,
        promotionsFutureTableUnprivileged: true,
        setRoleFailureDidNotLeak: true,
        runtimeAdminFlags: false,
        sharedSupabaseUsed: false,
        marketplaceDataCopied: false,
        commercialOperationsExercised: false,
      },
      null,
      2,
    ),
  );
} catch (error) {
  const errorText = error instanceof Error ? error.stack : String(error);
  console.error(
    [adminPassword, ...Object.values(runtimePasswords)].reduce(
      (safe, password) => safe.replaceAll(password, '[redacted]'),
      errorText,
    ),
  );
  process.exitCode = 1;
} finally {
  if (pool) {
    try {
      await pool.end();
    } catch {
      console.error('DATABASE_POOL_CLEANUP_FAILED');
      process.exitCode = 1;
    }
  }
  if (created) {
    try {
      const owned = docker([
        'inspect',
        '--format',
        `{{index .Config.Labels "${label}"}}`,
        container,
      ]);
      if (owned !== runId)
        throw new Error(
          'Disposable container ownership label mismatch; refusing cleanup',
        );
      docker(['rm', '--force', container]);
      assert(
        docker([
          'ps',
          '--all',
          '--filter',
          `label=${label}=${runId}`,
          '--format',
          '{{.Names}}',
        ]) === '',
        'Disposable container remains after cleanup',
      );
      console.log('DISPOSABLE_POSTGRES_CLEANUP_CONFIRMED');
    } catch (cleanupError) {
      console.error(`CLEANUP_FAILED: ${cleanupError.message}`);
      process.exitCode = 1;
    }
  }
}
