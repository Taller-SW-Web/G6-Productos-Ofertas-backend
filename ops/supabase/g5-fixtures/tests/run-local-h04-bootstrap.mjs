import { randomUUID } from 'node:crypto';
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
let created = false;
let pool;

function docker(args, options = {}) {
  return execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: 'pipe',
    ...options,
  }).trim();
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function sqlFile(path) {
  return readFile(resolve(root, path), 'utf8');
}

async function asRole(role, sql) {
  const client = await pool.connect();
  try {
    await client.query(`SET ROLE ${role}`);
    await client.query(sql);
  } finally {
    await client.query('RESET ROLE').catch(() => {});
    client.release();
  }
}

async function expectDenied(user, sql) {
  const client = new Pool({
    host: '127.0.0.1',
    port,
    user,
    database: dbName,
    max: 1,
  });
  try {
    await client.query(sql);
    throw new Error(`${user} unexpectedly executed a prohibited query`);
  } catch (error) {
    if (error.message.includes('unexpectedly executed')) throw error;
    if (!['42501', '3F000'].includes(error.code)) throw error;
  } finally {
    await client.end();
  }
}

let port;
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
    'POSTGRES_HOST_AUTH_METHOD=trust',
    '--env',
    `POSTGRES_DB=${dbName}`,
    'postgres:17.11',
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
    database: dbName,
    max: 6,
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

  await admin.query(`
    CREATE ROLE po_catalog_owner NOLOGIN;
    CREATE ROLE catalog_app LOGIN;
    CREATE ROLE po_inventory_owner NOLOGIN;
    CREATE ROLE po_inventory_runtime NOLOGIN;
    CREATE ROLE inventory_app LOGIN INHERIT;
    GRANT po_inventory_runtime TO inventory_app;
    CREATE ROLE po_pricing_owner NOLOGIN;
    CREATE ROLE pricing_app LOGIN;
    CREATE ROLE po_promotions_owner NOLOGIN;
    CREATE ROLE po_promotions_runtime NOLOGIN;
    CREATE ROLE promotions_app LOGIN INHERIT;
    GRANT po_promotions_runtime TO promotions_app;
    CREATE SCHEMA catalog AUTHORIZATION po_catalog_owner;
    CREATE SCHEMA pricing AUTHORIZATION po_pricing_owner;
    CREATE SCHEMA promotions AUTHORIZATION po_promotions_owner;
    CREATE SCHEMA extensions;
    CREATE EXTENSION btree_gist WITH SCHEMA extensions;
    GRANT USAGE ON SCHEMA extensions TO po_pricing_owner;
    REVOKE CREATE ON SCHEMA public FROM PUBLIC;
  `);
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
  await admin.query(
    'ALTER DEFAULT PRIVILEGES FOR ROLE po_promotions_owner IN SCHEMA promotions GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO po_promotions_runtime',
  );
  await admin.query(
    "SELECT set_config('g6.promotions_h5_runtime_role','po_promotions_runtime',false)",
  );
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
  await admin.query(
    'GRANT USAGE ON SCHEMA promotions TO po_promotions_runtime',
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
    const runtime = new Pool({
      host: '127.0.0.1',
      port,
      user,
      database: dbName,
      max: 1,
    });
    try {
      assert(
        (await runtime.query(sql)).rowCount === 1,
        `${user} runtime read failed`,
      );
    } finally {
      await runtime.end();
    }
  }
  for (const [user, schema] of [
    ['catalog_app', 'inventory'],
    ['inventory_app', 'pricing'],
    ['pricing_app', 'promotions'],
    ['promotions_app', 'catalog'],
  ])
    await expectDenied(
      user,
      `SELECT * FROM ${schema}.${schema === 'catalog' ? 'sku_identity' : schema === 'inventory' ? 'stock_balance' : schema === 'pricing' ? 'prices' : 'coupons'} LIMIT 0`,
    );
  const ddlRoleCheck = await admin.query(
    `SELECT bool_and(NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls) AS safe FROM pg_roles WHERE rolname IN ('catalog_app','inventory_app','pricing_app','promotions_app')`,
  );
  assert(
    ddlRoleCheck.rows[0].safe,
    'A runtime role has administrative PostgreSQL flags',
  );

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
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
} finally {
  await pool?.end().catch(() => {});
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
