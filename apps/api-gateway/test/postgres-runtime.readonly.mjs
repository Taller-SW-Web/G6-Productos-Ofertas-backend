import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { checkServerIdentity } from 'node:tls';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';

// Auditoría externa a Nest: únicamente SELECT, sin cargar env en process.env.
// No imprime errores de drivers, configuración privada ni filas de negocio.
const service = process.argv[2];
const files = {
  taxonomy: String.raw`C:\Users\marec\Desktop\G6-PostgresRuntime-Privado\taxonomy\.env.local`,
  catalog: String.raw`C:\Users\marec\Desktop\G6-PostgresRuntime-Privado\catalog\.env.local`,
};
const tables = {
  taxonomy: ['categories', 'brands'],
  catalog: [
    'products',
    'variants',
    'sku_identity',
    'product_images',
    'variant_images',
    'product_attribute_values',
    'variant_attribute_values',
    'product_identifying_characteristics',
    'sku_physical_profiles',
    'activation_checks',
    'master_barriers',
  ],
};
const schemas = [
  'taxonomy',
  'catalog',
  'pricing',
  'price_audit',
  'promotions',
  'combos',
  'inventory',
  'bulk',
];
const report = {
  service,
  date: new Date().toISOString(),
  node: process.version,
  probeSha256: createHash('sha256')
    .update(readFileSync(new URL(import.meta.url)))
    .digest('hex'),
  checks: {},
};
let client;
let stage = 'configuration';
try {
  assert(Object.hasOwn(files, service));
  const file = files[service];
  const e = parseEnv(readFileSync(file, 'utf8'));
  for (const key of [
    'PGHOST',
    'PGPORT',
    'PGDATABASE',
    'PGUSER',
    'PGPASSWORD',
    'PGSSLMODE',
    'PGSSLROOTCERT',
    'G6_DATABASE_SCHEMA',
    'G6_EXPECTED_ROLE',
  ])
    assert(e[key]?.trim());
  assert.equal(e.G6_DATABASE_SCHEMA, service);
  assert.equal(e.PGSSLMODE, 'verify-full');
  assert.equal(e.G6_EXPECTED_ROLE, `${service}_dev_login`);
  assert.equal(e.PGUSER.split('.')[0], e.G6_EXPECTED_ROLE);
  assert(/^\d+$/.test(e.PGPORT) && +e.PGPORT > 0 && +e.PGPORT <= 65535);
  const caPath = isAbsolute(e.PGSSLROOTCERT)
    ? e.PGSSLROOTCERT
    : resolve(dirname(file), e.PGSSLROOTCERT);
  const ca = readFileSync(caPath, 'utf8');
  assert(ca.includes('-----BEGIN CERTIFICATE-----'));
  const config = {
    host: e.G6_CONNECT_HOST || e.PGHOST,
    port: Number(e.PGPORT),
    database: e.PGDATABASE,
    user: e.PGUSER,
    password: e.PGPASSWORD,
    ssl: { ca, rejectUnauthorized: true, servername: e.PGHOST },
    connectionTimeoutMillis: 10000,
    query_timeout: 10000,
  };
  report.file = file;
  report.caPath = caPath;
  report.checks.configuration = 'PASS';
  client = new pg.Client(config);
  client.on('error', () => {});
  stage = 'connect';
  await client.connect();
  report.checks.authentication = 'PASS';
  assert(client.connection.stream.encrypted);
  assert.equal(client.connection.stream.authorized, true);
  report.checks.tlsCaHostname = 'PASS';
  stage = 'identity';
  const identity = await client.query(`SELECT current_user AS role,
    current_database() AS database,
    current_setting('default_transaction_read_only') AS readonly,
    r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb
    FROM pg_roles r WHERE r.rolname = current_user`);
  const row = identity.rows[0];
  report.identityChecks = {
    expectedRole: row.role === e.G6_EXPECTED_ROLE,
    expectedDatabase: row.database === e.PGDATABASE,
    serverDefaultReadOnly: row.readonly === 'on',
    nonAdministrative:
      !row.rolsuper &&
      !row.rolbypassrls &&
      !row.rolcreaterole &&
      !row.rolcreatedb,
  };
  assert.equal(row.role, e.G6_EXPECTED_ROLE);
  assert.equal(row.database, e.PGDATABASE);
  assert(
    !row.rolsuper &&
      !row.rolbypassrls &&
      !row.rolcreaterole &&
      !row.rolcreatedb,
  );
  const owner = await client.query(
    `SELECT EXISTS (
    SELECT 1 FROM pg_namespace n WHERE n.nspname = $1
    AND pg_has_role(current_user, n.nspowner, 'MEMBER')
  ) AS owner_member`,
    [service],
  );
  assert.equal(owner.rows[0].owner_member, false);
  report.identityChecks.ownerMembershipDenied = true;
  report.runtimeIdentity = row.role;
  const own = await client.query(
    "SELECT has_schema_privilege(current_user, $1, 'USAGE') AS usage",
    [service],
  );
  assert.equal(own.rows[0].usage, true);
  report.checks.ownSchema = 'PASS';
  report.select = [];
  for (const table of tables[service]) {
    let result = 'FAIL';
    let code;
    try {
      // Identificadores exclusivamente de listas cerradas arriba.
      await drizzle(client).execute(
        sql.raw(`SELECT * FROM "${service}"."${table}" LIMIT 1`),
      );
      result = 'PASS';
    } catch (error) {
      // Drizzle envuelve el error original; nunca volcar message/query/params.
      const pgCode = error?.cause?.code ?? error?.code;
      code = ['42501', '42P01', '42703'].includes(pgCode)
        ? pgCode
        : 'QUERY_FAILED';
    }
    report.select.push({
      table: `${service}.${table}`,
      result,
      ...(code ? { code } : {}),
    });
  }
  report.checks.select = report.select.every((r) => r.result === 'PASS')
    ? 'PASS'
    : 'FAIL';
  report.isolation = [];
  for (const other of schemas) {
    if (other === service) continue;
    const permission = await client.query(
      "SELECT has_schema_privilege(current_user, $1, 'USAGE') AS usage",
      [other],
    );
    const metadata = await client.query(
      'SELECT tablename FROM pg_tables WHERE schemaname = $1 ORDER BY tablename LIMIT 1',
      [other],
    );
    const table = metadata.rows[0]?.tablename;
    assert(typeof table === 'string' && /^[a-z_][a-z0-9_]*$/.test(table));
    let denied = false;
    try {
      await client.query(`SELECT 1 FROM "${other}"."${table}" LIMIT 0`);
    } catch (error) {
      denied = error.code === '42501';
    }
    report.isolation.push({
      schema: other,
      usageDenied: permission.rows[0].usage === false,
      selectDenied: denied,
    });
  }
  report.checks.isolation = report.isolation.every(
    (r) => r.usageDenied && r.selectDenied,
  )
    ? 'PASS'
    : 'FAIL';
  await client.end();
  client = undefined;
  // Negativo TLS sin tocar CA, archivos originales ni servidor.
  const negative = new pg.Client({
    ...config,
    ssl: {
      ...config.ssl,
      checkServerIdentity: (_hostname, certificate) =>
        checkServerIdentity('g6-hostname-negative.invalid', certificate),
    },
  });
  negative.on('error', () => {});
  let rejected = false;
  try {
    await negative.connect();
  } catch (error) {
    rejected = error.code === 'ERR_TLS_CERT_ALTNAME_INVALID';
  } finally {
    await negative.end().catch(() => {});
  }
  report.checks.tlsWrongHostnameRejected = rejected ? 'PASS' : 'FAIL';
  report.result = Object.values(report.checks).every((v) => v === 'PASS')
    ? 'PASS_READONLY_DRIZZLE'
    : 'FAIL';
} catch (error) {
  report.result = 'FAIL';
  report.stage = stage;
  report.failureCode =
    typeof error.code === 'string' && /^[A-Z0-9_]{3,64}$/.test(error.code)
      ? error.code
      : 'CHECK_FAILED';
  report.failure = 'Verificacion interrumpida; detalle privado no emitido.';
} finally {
  await client?.end().catch(() => {});
}
console.log(JSON.stringify(report, null, 2));
if (report.result !== 'PASS_READONLY_DRIZZLE') process.exitCode = 1;
