#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
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
  // Set UUID v4 version nibble and RFC 4122 variant bits
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

  // Ubicaciones deterministas: al menos 1 activa principal, 1 activa secundaria y si >2 se añade 1 inactiva y 1 sin stock
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
  // Si solo hay 2 ubicaciones, mantenemos ambas activas para cubrir 55x2=110 balances en baseline,
  // y agregamos una ubicación inactiva extra sin balances obligatorios o con 1 saldo de prueba en metadata,
  // o bien marcamos la última ubicación inactiva solo cuando locationsCount >= 3.
  // Para garantizar siempre escenario de ubicación inactiva incluso en small/baseline:
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

  // Canales y rutas comerciales con distinto fulfillment y ubicación (nunca sumar todas por defecto)
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
      channel_id: 'RETAIL_APP',
      mode: 'RETIRO_TIENDA',
      fulfillment_ref: `SYN-ROUTE-RET-${seedTag}`,
      location_id: locations[1].id,
      active: true,
    },
  ];

  // SKUs sintéticos con grupos obligatorios
  const skus = [];
  for (let i = 0; i < skuCount; i++) {
    const kind = i % 3 === 0 ? 'SIMPLE' : 'VARIANT';
    const sku = `SYN-${seedTag}-${kind === 'SIMPLE' ? 'SMP' : 'VAR'}-${String(i + 1).padStart(4, '0')}`;
    const isDeactivated = i === 7;
    skus.push({
      sku,
      kind,
      catalogActive: !isDeactivated,
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

  // Balances deterministas para cada (sku, location) en la matriz principal (skuCount * locationsCount)
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

  // Umbral global + override de SKU
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

  // Reserva vencida y operación reintentada sintéticas
  const expiredReservation = {
    reservation_id: deterministicUuid(seed, 'reservation:expired'),
    order_id: `SYN-ORD-EXP-${seedTag}`,
    operation_id: deterministicUuid(seed, 'operation:expired'),
    channel_id: 'MARKETPLACE',
    status: 'ACTIVA',
    expires_at: '2026-01-01T00:00:00.000Z',
    sku: skus[6].sku,
    location_id: locations[0].id,
    quantity: 3,
  };

  const retriedOperation = {
    operation_id: deterministicUuid(seed, 'operation:retried'),
    idempotency_key: `syn-idem-${seedTag}-retry`,
    operation_type: 'RESERVA',
    status: 'COMPLETED',
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

  const csv = buildCsv(balances);
  const sqlSha256 = sha256Hex(sql);
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
      csv_file: 'inventory-fixture.csv',
      csv_sha256: csvSha256,
    },
    commands: {
      generate: `node scripts/h5/fixtures/inventory/generate-inventory-fixture.mjs --seed ${seed} --profile ${profileName}`,
    },
  };

  const manifestJson = JSON.stringify(manifest, null, 2) + '\n';
  const manifestSha256 = sha256Hex(manifestJson);

  return {
    manifest,
    manifestJson,
    manifestSha256,
    sql,
    csv,
    locations: allLocations,
    skus,
    balances,
    commercialRoutes,
    unregisteredSku,
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
    '-- 2. Ciclo de vida SKU (Catalog)',
    ...skus.map(
      (s, idx) =>
        `INSERT INTO inventory.sku_lifecycle (sku_id, active, catalog_version) VALUES (${sqlStr(s.sku)}, ${s.catalogActive}, ${idx + 1}) ON CONFLICT (sku_id) DO NOTHING;`,
    ),
    '',
    '-- 3. Umbrales',
    ...thresholds.map(
      (t) =>
        `INSERT INTO inventory.stock_threshold_override (id, sku_id, location_id, umbral_efectivo) VALUES (${sqlStr(t.id)}, ${t.sku_id ? sqlStr(t.sku_id) : 'NULL'}, NULL, ${t.umbral_efectivo}) ON CONFLICT (id) DO NOTHING;`,
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
    '-- 6. Operaciones y reserva vencida sintética',
    `INSERT INTO inventory.inventory_operations (operation_id, operation_type, idempotency_key, client_id, status) VALUES (${sqlStr(expiredReservation.operation_id)}, 'RESERVA', ${sqlStr(`syn-exp-${expiredReservation.operation_id}`)}, 'modulo-ventas', 'COMPLETED') ON CONFLICT (operation_id) DO NOTHING;`,
    `INSERT INTO inventory.inventory_operations (operation_id, operation_type, idempotency_key, client_id, status) VALUES (${sqlStr(retriedOperation.operation_id)}, ${sqlStr(retriedOperation.operation_type)}, ${sqlStr(retriedOperation.idempotency_key)}, 'modulo-ventas', ${sqlStr(retriedOperation.status)}) ON CONFLICT (operation_id) DO NOTHING;`,
    `INSERT INTO inventory.reservations (reservation_id, order_id, operation_id, channel_id, status, expires_at) VALUES (${sqlStr(expiredReservation.reservation_id)}, ${sqlStr(expiredReservation.order_id)}, ${sqlStr(expiredReservation.operation_id)}, ${sqlStr(expiredReservation.channel_id)}, 'ACTIVA', ${sqlStr(expiredReservation.expires_at)}) ON CONFLICT (reservation_id) DO NOTHING;`,
    `INSERT INTO inventory.reservation_lines (reservation_id, sku_id, location_id, quantity) VALUES (${sqlStr(expiredReservation.reservation_id)}, ${sqlStr(expiredReservation.sku)}, ${sqlStr(expiredReservation.location_id)}, ${expiredReservation.quantity}) ON CONFLICT DO NOTHING;`,
    '',
    'COMMIT;',
    '',
  ];
  return lines.join('\n');
}

function buildCsv(balances) {
  const header = 'sku_id,location_id,on_hand,reserved,blocked,available';
  const rows = balances.map(
    (b) =>
      `${b.sku_id},${b.location_id},${b.on_hand},${b.reserved},${b.blocked},${b.available}`,
  );
  return [header, ...rows].join('\n') + '\n';
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      opts.dryRun = true;
    } else if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const val = argv[++i];
      if (key === 'seed') opts.seed = val;
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

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.dbUrl) assertIsolatedDatabaseUrl(opts.dbUrl);
  if (process.env.DATABASE_URL)
    assertIsolatedDatabaseUrl(process.env.DATABASE_URL);

  const result = generateInventoryFixtureData(opts);
  if (opts.dryRun) {
    console.log(
      JSON.stringify(
        {
          dryRun: true,
          profile: result.manifest.profile,
          seed: result.manifest.seed,
          counts: result.manifest.counts,
          aggregate: result.manifest.aggregate,
          sql_sha256: result.manifest.artifacts.sql_sha256,
          manifest_sha256: result.manifestSha256,
        },
        null,
        2,
      ),
    );
    return;
  }

  const outDir = resolve(
    opts.out ?? join(dirname(fileURLToPath(import.meta.url)), 'out'),
  );
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, 'inventory-fixture.sql'), result.sql, 'utf8');
  await writeFile(join(outDir, 'inventory-fixture.csv'), result.csv, 'utf8');
  await writeFile(join(outDir, 'manifest.json'), result.manifestJson, 'utf8');
  await writeFile(
    join(outDir, 'manifest.sha256'),
    `${result.manifestSha256}  manifest.json\n`,
    'utf8',
  );
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
