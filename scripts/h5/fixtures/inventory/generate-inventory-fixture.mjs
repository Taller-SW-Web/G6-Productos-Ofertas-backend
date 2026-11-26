#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROFILES = {
  small: { skuCount: 10, locationsCount: 2, maxLimit: 1000 },
  baseline: { skuCount: 55, locationsCount: 2, maxLimit: 1000 },
  load: { skuCount: 500, locationsCount: 5, maxLimit: 5000 },
};

const DEFAULT_THRESHOLD = 5;
const DEFAULT_UTC = '2026-11-26T00:00:00.000Z';

function sha256Hex(input) {
  return createHash('sha256').update(input).digest('hex');
}

export function deterministicUuid(seed, namespace) {
  const hex = sha256Hex(`${seed}::${namespace}`).slice(0, 32).split('');
  hex[12] = '4';
  const variantNibble = (parseInt(hex[16], 16) & 0x3) | 0x8;
  hex[16] = variantNibble.toString(16);
  const s = hex.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}

function createPrng(seed) {
  let state = parseInt(sha256Hex(String(seed)).slice(0, 8), 16) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function assertIsolatedDatabaseUrl(connectionString) {
  if (!connectionString) return;
  let parsed;
  try {
    parsed = new URL(connectionString);
  } catch {
    throw new Error('INV03_UNSAFE_DB_URL: cadena de conexión inválida.');
  }
  const host = parsed.hostname.toLowerCase();
  const forbiddenPatterns = [
    /supabase\.co$/i,
    /supabase\.com$/i,
    /supabase\.net$/i,
    /azure\.com$/i,
    /prod/i,
    /shared/i,
  ];
  if (forbiddenPatterns.some((re) => re.test(host))) {
    throw new Error(
      `INV03_UNSAFE_DB_URL: prohibido ejecutar fixtures sintéticos contra host compartido o productivo (${host}).`,
    );
  }
  const allowedHosts = new Set([
    '127.0.0.1',
    'localhost',
    '::1',
    'postgres',
    'inventory-it-pg',
  ]);
  if (!allowedHosts.has(host) && !host.startsWith('inventory-it-')) {
    throw new Error(
      `INV03_UNSAFE_DB_URL: solo se permite PostgreSQL local o descartable (${host}).`,
    );
  }
}

export function generateInventoryFixtureData(options = {}) {
  const profileName = options.profile ?? 'baseline';
  const profileSpec = PROFILES[profileName];
  if (!profileSpec) {
    throw new Error(
      `Perfil inválido "${profileName}". Valores permitidos: ${Object.keys(PROFILES).join(', ')}.`,
    );
  }

  const seed = String(options.seed ?? '20261126');
  const skuCount = Number(options.skuCount ?? profileSpec.skuCount);
  const locationsCount = Number(
    options.locationsCount ?? profileSpec.locationsCount,
  );
  const generatedAtUtc = String(options.utc ?? DEFAULT_UTC);

  if (
    !Number.isInteger(skuCount) ||
    skuCount < 10 ||
    skuCount > profileSpec.maxLimit
  ) {
    throw new Error(
      `sku-count debe ser entero entre 10 y ${profileSpec.maxLimit} para perfil ${profileName}.`,
    );
  }
  if (
    !Number.isInteger(locationsCount) ||
    locationsCount < 2 ||
    locationsCount > 20
  ) {
    throw new Error('locations debe ser entero entre 2 y 20.');
  }

  const rand = createPrng(seed);
  const seedTag = sha256Hex(seed).slice(0, 6).toUpperCase();

  const locations = [];
  for (let i = 0; i < locationsCount; i++) {
    const isInactive = locationsCount >= 3 && i === locationsCount - 1;
    const isStore = i % 2 === 1;
    locations.push({
      id: deterministicUuid(seed, `location:${i}`),
      code: `SYN-${seedTag}-LOC-${String(i + 1).padStart(2, '0')}`,
      name: `Ubicacion Sintetica ${i + 1} (${seedTag})`,
      type: isStore ? 'TIENDA' : 'ALMACEN',
      active: !isInactive,
    });
  }
  const inactiveLocation = {
    id: deterministicUuid(seed, 'location:inactive-extra'),
    code: `SYN-${seedTag}-LOC-INACT`,
    name: `Ubicacion Inactiva Sintetica (${seedTag})`,
    type: 'TIENDA',
    active: false,
  };
  const emptyLocation = {
    id: deterministicUuid(seed, 'location:empty-extra'),
    code: `SYN-${seedTag}-LOC-EMPTY`,
    name: `Ubicacion Sin Stock Sintetica (${seedTag})`,
    type: 'ALMACEN',
    active: true,
  };

  // Canales válidos según CHECK (channel_id IN ('MARKETPLACE', 'CHATBOT', 'RETAIL'))
  const commercialRoutes = [
    {
      id: deterministicUuid(seed, 'route:marketplace'),
      channel_id: 'MARKETPLACE',
      mode: 'ENVIO_DOMICILIO',
      fulfillment_ref: `SYN-ROUTE-MKT-${seedTag}`,
      location_id: locations[0].id,
      active: true,
    },
    {
      id: deterministicUuid(seed, 'route:retail-pickup'),
      channel_id: 'RETAIL',
      mode: 'RETIRO_TIENDA',
      fulfillment_ref: `SYN-ROUTE-RET-${seedTag}`,
      location_id: locations[1].id,
      active: true,
    },
  ];

  const skus = [];
  for (let i = 0; i < skuCount; i++) {
    const kind = i % 3 === 0 ? 'SIMPLE' : 'VARIANT';
    const sku = `SYN-${seedTag}-${kind === 'SIMPLE' ? 'SMP' : 'VAR'}-${String(i + 1).padStart(4, '0')}`;
    const isDeactivated = i === 7;
    skus.push({
      sku,
      product_id: deterministicUuid(seed, `product:${sku}`),
      sku_version: i + 1,
      kind,
      catalogActive: !isDeactivated,
      changed_at: generatedAtUtc,
      group:
        i === 0
          ? 'AVAILABLE_ZERO'
          : i === 1
            ? 'EXACT_THRESHOLD'
            : i === 2
              ? 'THRESHOLD_PLUS_ONE'
              : i === 3
                ? 'PARTIAL_RESERVED'
                : i === 4
                  ? 'WITH_BLOCKED'
                  : i === 5
                    ? 'RESERVED_ZERO_AVAILABLE'
                    : i === 6
                      ? 'EXPIRED_RESERVATION'
                      : i === 7
                        ? 'DEACTIVATED_CATALOG'
                        : i === 8
                          ? 'RETRIED_OPERATION'
                          : 'STANDARD_AVAILABLE',
    });
  }

  const unregisteredSku = `SYN-${seedTag}-UNREG-9999`;

  const balances = [];
  for (let sIdx = 0; sIdx < skus.length; sIdx++) {
    const skuObj = skus[sIdx];
    for (let lIdx = 0; lIdx < locations.length; lIdx++) {
      const loc = locations[lIdx];
      let onHand = 20 + Math.floor(rand() * 40);
      let reserved = 0;
      let blocked = 0;

      if (lIdx === 0) {
        if (skuObj.group === 'AVAILABLE_ZERO') {
          onHand = 0;
        } else if (skuObj.group === 'EXACT_THRESHOLD') {
          onHand = DEFAULT_THRESHOLD;
        } else if (skuObj.group === 'THRESHOLD_PLUS_ONE') {
          onHand = DEFAULT_THRESHOLD + 1;
        } else if (skuObj.group === 'PARTIAL_RESERVED') {
          onHand = 20;
          reserved = 7;
        } else if (skuObj.group === 'WITH_BLOCKED') {
          onHand = 15;
          reserved = 2;
          blocked = 4;
        } else if (skuObj.group === 'RESERVED_ZERO_AVAILABLE') {
          onHand = 6;
          reserved = 6;
        } else if (skuObj.group === 'EXPIRED_RESERVATION') {
          onHand = 12;
          reserved = 3;
        }
      }

      const available = Math.max(0, onHand - reserved - blocked);
      balances.push({
        sku_id: skuObj.sku,
        location_id: loc.id,
        on_hand: onHand,
        reserved,
        blocked,
        available,
      });
    }
  }

  const thresholds = [
    {
      id: deterministicUuid(seed, 'threshold:global'),
      sku_id: null,
      location_id: null,
      umbral_efectivo: DEFAULT_THRESHOLD,
    },
    {
      id: deterministicUuid(seed, 'threshold:sku-1'),
      sku_id: skus[2].sku,
      location_id: null,
      umbral_efectivo: 4,
    },
  ];

  // reservations.id (PK) vs reservations.reservation_id (business UUID); reservation_lines.reservation_id FK -> reservations.id
  const expiredReservation = {
    id: deterministicUuid(seed, 'reservation-pk:expired'),
    reservation_id: deterministicUuid(seed, 'reservation:expired'),
    line_id: deterministicUuid(seed, 'reservation-line:expired'),
    order_id: `SYN-ORD-EXP-${seedTag}`,
    operation_pk: deterministicUuid(seed, 'operation-pk:expired'),
    operation_id: deterministicUuid(seed, 'operation:expired'),
    idempotency_key: `syn-res-exp-${seedTag}`,
    op_idempotency_key: `syn-op-exp-${seedTag}`,
    channel_id: 'MARKETPLACE',
    status: 'ACTIVA',
    expires_at: '2026-01-01T00:00:00.000Z',
    sku: skus[6].sku,
    location_id: locations[0].id,
    quantity: 3,
  };

  const retriedOperation = {
    id: deterministicUuid(seed, 'operation-pk:retried'),
    operation_id: deterministicUuid(seed, 'operation:retried'),
    idempotency_key: `syn-idem-${seedTag}-retry`,
    operation_type: 'RESERVA',
    intention: 'reservar',
    status: 'APLICADO',
    sku: skus[8].sku,
    location_id: locations[0].id,
  };

  const allLocations = [...locations, inactiveLocation, emptyLocation];
  const aggregate = balances.reduce(
    (acc, b) => {
      acc.totalOnHand += b.on_hand;
      acc.totalReserved += b.reserved;
      acc.totalBlocked += b.blocked;
      acc.totalAvailable += b.available;
      return acc;
    },
    { totalOnHand: 0, totalReserved: 0, totalBlocked: 0, totalAvailable: 0 },
  );

  const sql = buildSql({
    allLocations,
    skus,
    balances,
    thresholds,
    commercialRoutes,
    expiredReservation,
    retriedOperation,
  });

  const cleanupSql = buildCleanupSql({
    allLocations,
    skus,
    thresholds,
    commercialRoutes,
    expiredReservation,
    retriedOperation,
  });

  const csv = buildCsv(balances);
  const sqlSha256 = sha256Hex(sql);
  const cleanupSqlSha256 = sha256Hex(cleanupSql);
  const csvSha256 = sha256Hex(csv);

  const manifest = {
    schema_version: 'inventory-h5-fixture-v1',
    seed,
    profile: profileName,
    generated_at_utc: generatedAtUtc,
    counts: {
      skus: skus.length,
      unregistered_skus: 1,
      primary_locations: locations.length,
      total_locations: allLocations.length,
      balances: balances.length,
      commercial_routes: commercialRoutes.length,
      thresholds: thresholds.length,
    },
    aggregate,
    mandatory_groups: {
      available_zero_sku: skus[0].sku,
      exact_threshold_sku: skus[1].sku,
      threshold_plus_one_sku: skus[2].sku,
      partial_reserved_sku: skus[3].sku,
      with_blocked_sku: skus[4].sku,
      reserved_zero_available_sku: skus[5].sku,
      expired_reservation_id: expiredReservation.reservation_id,
      expired_reservation_pk: expiredReservation.id,
      deactivated_catalog_sku: skus[7].sku,
      retried_operation_id: retriedOperation.operation_id,
      unregistered_sku: unregisteredSku,
      inactive_location_id: inactiveLocation.id,
      empty_location_id: emptyLocation.id,
    },
    synthetic_actors: {
      manager_sub: deterministicUuid(seed, 'actor:manager'),
      sales_client_id: 'modulo-ventas',
    },
    channels: commercialRoutes.map((r) => ({
      channel_id: r.channel_id,
      mode: r.mode,
      location_id: r.location_id,
    })),
    artifacts: {
      sql_file: 'inventory-fixture.sql',
      sql_sha256: sqlSha256,
      cleanup_sql_file: 'inventory-fixture-cleanup.sql',
      cleanup_sql_sha256: cleanupSqlSha256,
      csv_file: 'inventory-fixture.csv',
      csv_sha256: csvSha256,
    },
    commands: {
      generate: `node scripts/h5/fixtures/inventory/generate-inventory-fixture.mjs --mode generate --seed ${seed} --profile ${profileName}`,
      verify: `node scripts/h5/fixtures/inventory/generate-inventory-fixture.mjs --mode verify --seed ${seed} --profile ${profileName}`,
      cleanup: `node scripts/h5/fixtures/inventory/generate-inventory-fixture.mjs --mode cleanup --seed ${seed} --profile ${profileName}`,
    },
  };

  const manifestJson = JSON.stringify(manifest, null, 2) + '\n';
  const manifestSha256 = sha256Hex(manifestJson);

  return {
    manifest,
    manifestJson,
    manifestSha256,
    sql,
    cleanupSql,
    csv,
    locations: allLocations,
    skus,
    balances,
    commercialRoutes,
    unregisteredSku,
    expiredReservation,
    retriedOperation,
    thresholds,
  };
}

function sqlStr(val) {
  return `'${String(val).replaceAll("'", "''")}'`;
}

function buildSql({
  allLocations,
  skus,
  balances,
  thresholds,
  commercialRoutes,
  expiredReservation,
  retriedOperation,
}) {
  const lines = [
    '-- Fixture sintético determinista Inventory H5 (SOLO PostgreSQL descartable)',
    'BEGIN;',
    '',
    '-- 1. Ubicaciones',
    ...allLocations.map(
      (l) =>
        `INSERT INTO inventory.locations (id, code, name, type, active) VALUES (${sqlStr(l.id)}, ${sqlStr(l.code)}, ${sqlStr(l.name)}, ${sqlStr(l.type)}, ${l.active}) ON CONFLICT (id) DO NOTHING;`,
    ),
    '',
    '-- 2. Ciclo de vida SKU (sku_lifecycle schema real)',
    ...skus.map(
      (s) =>
        `INSERT INTO inventory.sku_lifecycle (sku_id, product_id, sku_version, active, changed_at) VALUES (${sqlStr(s.sku)}, ${sqlStr(s.product_id)}, ${s.sku_version}, ${s.catalogActive}, ${sqlStr(s.changed_at)}) ON CONFLICT (sku_id) DO NOTHING;`,
    ),
    '',
    '-- 3. Umbrales',
    ...thresholds.map(
      (t) =>
        `INSERT INTO inventory.stock_threshold_override (id, sku_id, location_id, umbral_efectivo) VALUES (${sqlStr(t.id)}, ${t.sku_id ? sqlStr(t.sku_id) : 'NULL'}, NULL, ${t.umbral_efectivo}) ON CONFLICT DO NOTHING;`,
    ),
    '',
    '-- 4. Saldos físicos (sin insertar columna generada available)',
    ...balances.map(
      (b) =>
        `INSERT INTO inventory.stock_balance (sku_id, location_id, on_hand, reserved, blocked) VALUES (${sqlStr(b.sku_id)}, ${sqlStr(b.location_id)}, ${b.on_hand}, ${b.reserved}, ${b.blocked}) ON CONFLICT (sku_id, location_id) DO NOTHING;`,
    ),
    '',
    '-- 5. Rutas comerciales por canal y fulfillment',
    ...commercialRoutes.map(
      (r) =>
        `INSERT INTO inventory.commercial_fulfillment_routes (id, channel_id, mode, fulfillment_ref, location_id, active) VALUES (${sqlStr(r.id)}, ${sqlStr(r.channel_id)}, ${sqlStr(r.mode)}, ${sqlStr(r.fulfillment_ref)}, ${sqlStr(r.location_id)}, ${r.active}) ON CONFLICT (id) DO NOTHING;`,
    ),
    '',
    '-- 6. Operaciones durables (intention NOT NULL, status operation_status enum)',
    `INSERT INTO inventory.inventory_operations (id, operation_type, idempotency_key, intention, status, order_id, reservation_id, operation_id, client_id) VALUES (${sqlStr(expiredReservation.operation_pk)}, 'RESERVA', ${sqlStr(expiredReservation.op_idempotency_key)}, 'reservar', 'APLICADO', ${sqlStr(expiredReservation.order_id)}, ${sqlStr(expiredReservation.reservation_id)}, ${sqlStr(expiredReservation.operation_id)}, 'modulo-ventas') ON CONFLICT (idempotency_key) DO NOTHING;`,
    `INSERT INTO inventory.inventory_operations (id, operation_type, idempotency_key, intention, status, sku_id, location_id, operation_id, client_id) VALUES (${sqlStr(retriedOperation.id)}, ${sqlStr(retriedOperation.operation_type)}, ${sqlStr(retriedOperation.idempotency_key)}, ${sqlStr(retriedOperation.intention)}, ${sqlStr(retriedOperation.status)}, ${sqlStr(retriedOperation.sku)}, ${sqlStr(retriedOperation.location_id)}, ${sqlStr(retriedOperation.operation_id)}, 'modulo-ventas') ON CONFLICT (idempotency_key) DO NOTHING;`,
    '',
    '-- 7. Reserva vencida sintética y líneas (reservation_lines.reservation_id -> reservations.id)',
    `INSERT INTO inventory.reservations (id, reservation_id, status, expires_at, idempotency_key, intention, order_id, operation_id) VALUES (${sqlStr(expiredReservation.id)}, ${sqlStr(expiredReservation.reservation_id)}, 'ACTIVA', ${sqlStr(expiredReservation.expires_at)}, ${sqlStr(expiredReservation.idempotency_key)}, 'reservar', ${sqlStr(expiredReservation.order_id)}, ${sqlStr(expiredReservation.operation_id)}) ON CONFLICT (reservation_id) DO NOTHING;`,
    `INSERT INTO inventory.reservation_lines (id, reservation_id, sku_id, location_id, quantity) VALUES (${sqlStr(expiredReservation.line_id)}, ${sqlStr(expiredReservation.id)}, ${sqlStr(expiredReservation.sku)}, ${sqlStr(expiredReservation.location_id)}, ${expiredReservation.quantity}) ON CONFLICT (reservation_id, sku_id, location_id) DO NOTHING;`,
    '',
    'COMMIT;',
    '',
  ];
  return lines.join('\n');
}

function buildCleanupSql({
  allLocations,
  skus,
  thresholds,
  commercialRoutes,
  expiredReservation,
  retriedOperation,
}) {
  const locIds = allLocations.map((l) => sqlStr(l.id)).join(', ');
  const skuIds = skus.map((s) => sqlStr(s.sku)).join(', ');
  const thresholdIds = thresholds.map((t) => sqlStr(t.id)).join(', ');
  const routeIds = commercialRoutes.map((r) => sqlStr(r.id)).join(', ');
  const opIds = [expiredReservation.operation_pk, retriedOperation.id]
    .map(sqlStr)
    .join(', ');

  return [
    '-- Limpieza idempotente del fixture sintético Inventory H5',
    'BEGIN;',
    `DELETE FROM inventory.reservation_lines WHERE reservation_id = ${sqlStr(expiredReservation.id)};`,
    `DELETE FROM inventory.reservations WHERE id = ${sqlStr(expiredReservation.id)};`,
    `DELETE FROM inventory.inventory_operations WHERE id IN (${opIds});`,
    `DELETE FROM inventory.commercial_fulfillment_routes WHERE id IN (${routeIds});`,
    `DELETE FROM inventory.stock_balance WHERE location_id IN (${locIds});`,
    `DELETE FROM inventory.stock_threshold_override WHERE id IN (${thresholdIds});`,
    `DELETE FROM inventory.sku_lifecycle WHERE sku_id IN (${skuIds});`,
    `DELETE FROM inventory.locations WHERE id IN (${locIds});`,
    'COMMIT;',
    '',
  ].join('\n');
}

function buildCsv(balances) {
  const header = 'sku_id,location_id,on_hand,reserved,blocked,available';
  const rows = balances.map(
    (b) =>
      `${b.sku_id},${b.location_id},${b.on_hand},${b.reserved},${b.blocked},${b.available}`,
  );
  return [header, ...rows].join('\n') + '\n';
}

export async function verifyGeneratedArtifacts(outDir, expectedOptions = {}) {
  const manifestRaw = await readFile(join(outDir, 'manifest.json'), 'utf8');
  const manifestShaFile = (
    await readFile(join(outDir, 'manifest.sha256'), 'utf8')
  ).trim();
  const actualManifestSha = sha256Hex(manifestRaw);
  if (manifestShaFile !== `${actualManifestSha}  manifest.json`) {
    throw new Error(
      'INV03_VERIFY_FAILED: manifest.sha256 no coincide con manifest.json',
    );
  }
  const manifest = JSON.parse(manifestRaw);
  const sql = await readFile(join(outDir, manifest.artifacts.sql_file), 'utf8');
  const cleanupSql = await readFile(
    join(outDir, manifest.artifacts.cleanup_sql_file),
    'utf8',
  );
  const csv = await readFile(join(outDir, manifest.artifacts.csv_file), 'utf8');
  if (sha256Hex(sql) !== manifest.artifacts.sql_sha256) {
    throw new Error('INV03_VERIFY_FAILED: sql_sha256 no coincide');
  }
  if (sha256Hex(cleanupSql) !== manifest.artifacts.cleanup_sql_sha256) {
    throw new Error('INV03_VERIFY_FAILED: cleanup_sql_sha256 no coincide');
  }
  if (sha256Hex(csv) !== manifest.artifacts.csv_sha256) {
    throw new Error('INV03_VERIFY_FAILED: csv_sha256 no coincide');
  }
  if (expectedOptions.seed && manifest.seed !== String(expectedOptions.seed)) {
    throw new Error('INV03_VERIFY_FAILED: seed no coincide');
  }
  if (expectedOptions.profile && manifest.profile !== expectedOptions.profile) {
    throw new Error('INV03_VERIFY_FAILED: profile no coincide');
  }
  return { manifest, actualManifestSha };
}

function parseArgs(argv) {
  const opts = { mode: 'generate' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      opts.dryRun = true;
    } else if (arg === 'generate' || arg === 'verify' || arg === 'cleanup') {
      opts.mode = arg;
    } else if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const val = argv[++i];
      if (key === 'mode') opts.mode = val;
      else if (key === 'seed') opts.seed = val;
      else if (key === 'sku-count') opts.skuCount = Number(val);
      else if (key === 'locations') opts.locationsCount = Number(val);
      else if (key === 'profile') opts.profile = val;
      else if (key === 'out') opts.out = val;
      else if (key === 'utc') opts.utc = val;
      else if (key === 'db-url') opts.dbUrl = val;
    }
  }
  return opts;
}

async function runWithPg(dbUrl, fn) {
  assertIsolatedDatabaseUrl(dbUrl);
  const pgModule = await import('pg');
  const Client = pgModule.default?.Client ?? pgModule.Client;
  const client = new Client({ connectionString: dbUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const dbUrl = opts.dbUrl ?? process.env.DATABASE_URL;
  if (dbUrl) assertIsolatedDatabaseUrl(dbUrl);

  const outDir = resolve(
    opts.out ?? join(dirname(fileURLToPath(import.meta.url)), 'out'),
  );

  if (opts.mode === 'verify') {
    const { manifest, actualManifestSha } = await verifyGeneratedArtifacts(
      outDir,
      opts,
    );
    if (dbUrl) {
      const data = await runWithPg(dbUrl, async (client) => {
        const locIds = [
          ...Array.from({ length: manifest.counts.primary_locations }, (_, i) =>
            deterministicUuid(manifest.seed, `location:${i}`),
          ),
          manifest.mandatory_groups.inactive_location_id,
          manifest.mandatory_groups.empty_location_id,
        ];
        const res = await client.query(
          `SELECT COUNT(*)::int AS balances,
                  COALESCE(SUM(on_hand), 0)::int AS on_hand,
                  COALESCE(SUM(reserved), 0)::int AS reserved,
                  COALESCE(SUM(blocked), 0)::int AS blocked,
                  COALESCE(SUM(available), 0)::int AS available
           FROM inventory.stock_balance
           WHERE location_id = ANY($1::uuid[])`,
          [locIds],
        );
        return res.rows[0];
      });
      if (
        data.balances !== manifest.counts.balances ||
        data.on_hand !== manifest.aggregate.totalOnHand ||
        data.reserved !== manifest.aggregate.totalReserved ||
        data.blocked !== manifest.aggregate.totalBlocked ||
        data.available !== manifest.aggregate.totalAvailable
      ) {
        throw new Error(
          `INV03_DB_VERIFY_FAILED: DB=${JSON.stringify(data)} vs manifest=${JSON.stringify(manifest.aggregate)}`,
        );
      }
    }
    console.log(
      JSON.stringify({
        mode: 'verify',
        status: 'PASS',
        profile: manifest.profile,
        seed: manifest.seed,
        manifest_sha256: actualManifestSha,
        db_verified: Boolean(dbUrl),
      }),
    );
    return;
  }

  if (opts.mode === 'cleanup') {
    const result = generateInventoryFixtureData(opts);
    if (opts.dryRun) {
      console.log(
        JSON.stringify({
          mode: 'cleanup',
          dryRun: true,
          cleanup_sql_sha256: result.manifest.artifacts.cleanup_sql_sha256,
        }),
      );
      return;
    }
    if (dbUrl) {
      await runWithPg(dbUrl, async (client) => {
        await client.query(result.cleanupSql);
      });
    }
    console.log(
      JSON.stringify({
        mode: 'cleanup',
        status: 'PASS',
        db_cleaned: Boolean(dbUrl),
      }),
    );
    return;
  }

  const result = generateInventoryFixtureData(opts);
  if (opts.dryRun) {
    console.log(
      JSON.stringify(
        {
          mode: 'generate',
          dryRun: true,
          profile: result.manifest.profile,
          seed: result.manifest.seed,
          counts: result.manifest.counts,
          aggregate: result.manifest.aggregate,
          sql_sha256: result.manifest.artifacts.sql_sha256,
          cleanup_sql_sha256: result.manifest.artifacts.cleanup_sql_sha256,
          manifest_sha256: result.manifestSha256,
        },
        null,
        2,
      ),
    );
    return;
  }

  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, 'inventory-fixture.sql'), result.sql, 'utf8');
  await writeFile(
    join(outDir, 'inventory-fixture-cleanup.sql'),
    result.cleanupSql,
    'utf8',
  );
  await writeFile(join(outDir, 'inventory-fixture.csv'), result.csv, 'utf8');
  await writeFile(join(outDir, 'manifest.json'), result.manifestJson, 'utf8');
  await writeFile(
    join(outDir, 'manifest.sha256'),
    `${result.manifestSha256}  manifest.json\n`,
    'utf8',
  );

  if (dbUrl) {
    await runWithPg(dbUrl, async (client) => {
      await client.query(result.sql);
    });
  }

  console.log(
    `Fixture generado en ${outDir} (manifest sha256: ${result.manifestSha256})`,
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
