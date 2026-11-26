import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertIsolatedDatabaseUrl,
  generateInventoryFixtureData,
  verifyGeneratedArtifacts,
} from '../../../../scripts/h5/fixtures/inventory/generate-inventory-fixture.mjs';

describe('INV-03 / TAC-A01 — Generador determinista de fixtures sintéticos de Inventory', () => {
  it('es determinista: misma semilla y perfil producen exactamente el mismo SHA-256 de SQL, CSV y manifest', () => {
    const first = generateInventoryFixtureData({
      seed: '20261126',
      profile: 'baseline',
    });
    const second = generateInventoryFixtureData({
      seed: '20261126',
      profile: 'baseline',
    });

    expect(first.manifestSha256).toBe(second.manifestSha256);
    expect(first.manifest.artifacts.sql_sha256).toBe(
      second.manifest.artifacts.sql_sha256,
    );
    expect(first.manifest.artifacts.csv_sha256).toBe(
      second.manifest.artifacts.csv_sha256,
    );
    expect(first.manifest.counts.skus).toBe(55);
    expect(first.manifest.counts.primary_locations).toBe(2);
    expect(first.manifest.counts.balances).toBe(110);
  });

  it('cambia el SHA-256 y los UUIDs al cambiar la semilla', () => {
    const a = generateInventoryFixtureData({
      seed: 'seed-A',
      profile: 'small',
    });
    const b = generateInventoryFixtureData({
      seed: 'seed-B',
      profile: 'small',
    });

    expect(a.manifestSha256).not.toBe(b.manifestSha256);
    expect(a.manifest.artifacts.sql_sha256).not.toBe(
      b.manifest.artifacts.sql_sha256,
    );
    expect(a.locations[0].id).not.toBe(b.locations[0].id);
  });

  it('respeta los perfiles small (10/2), baseline (55/2) y load (500/5)', () => {
    const small = generateInventoryFixtureData({ profile: 'small' });
    expect(small.manifest.counts.skus).toBe(10);
    expect(small.manifest.counts.balances).toBe(20);

    const load = generateInventoryFixtureData({ profile: 'load' });
    expect(load.manifest.counts.skus).toBe(500);
    expect(load.manifest.counts.primary_locations).toBe(5);
    expect(load.manifest.counts.balances).toBe(2500);
  });

  it('mantiene invariantes no negativos, available = on_hand - reserved - blocked y suma exacta con aggregate', () => {
    const result = generateInventoryFixtureData({
      seed: 'invariants-check',
      profile: 'baseline',
    });

    let sumOnHand = 0;
    let sumReserved = 0;
    let sumBlocked = 0;
    let sumAvailable = 0;

    for (const row of result.balances) {
      expect(row.on_hand).toBeGreaterThanOrEqual(0);
      expect(row.reserved).toBeGreaterThanOrEqual(0);
      expect(row.blocked).toBeGreaterThanOrEqual(0);
      expect(row.reserved + row.blocked).toBeLessThanOrEqual(row.on_hand);
      expect(row.available).toBe(
        Math.max(0, row.on_hand - row.reserved - row.blocked),
      );
      sumOnHand += row.on_hand;
      sumReserved += row.reserved;
      sumBlocked += row.blocked;
      sumAvailable += row.available;
    }

    expect(result.manifest.aggregate).toEqual({
      totalOnHand: sumOnHand,
      totalReserved: sumReserved,
      totalBlocked: sumBlocked,
      totalAvailable: sumAvailable,
    });
    // Verifica que no inserta columna generada available en el SQL
    expect(result.sql).not.toContain(
      'INSERT INTO inventory.stock_balance (sku_id, location_id, on_hand, reserved, blocked, available)',
    );
  });

  it('incluye todos los grupos obligatorios de SKU, ubicaciones activas/inactivas y 2 canales con distinto fulfillment', () => {
    const result = generateInventoryFixtureData({
      seed: 'groups-check',
      profile: 'baseline',
    });

    expect(result.locations.some((l) => l.active === false)).toBe(true);
    expect(result.locations.some((l) => l.active === true)).toBe(true);
    expect(result.skus.some((s) => s.catalogActive === false)).toBe(true);
    expect(result.skus.some((s) => s.kind === 'SIMPLE')).toBe(true);
    expect(result.skus.some((s) => s.kind === 'VARIANT')).toBe(true);
    expect(result.commercialRoutes.length).toBeGreaterThanOrEqual(2);
    expect(
      new Set(result.commercialRoutes.map((r) => r.channel_id)).size,
    ).toBeGreaterThanOrEqual(2);
    expect(result.commercialRoutes.map((r) => r.channel_id).sort()).toEqual([
      'MARKETPLACE',
      'RETAIL',
    ]);
    expect(
      new Set(result.commercialRoutes.map((r) => r.location_id)).size,
    ).toBeGreaterThanOrEqual(2);
    // Verifica columnas reales del esquema PostgreSQL de Inventory
    expect(result.sql).toContain(
      'INSERT INTO inventory.sku_lifecycle (sku_id, product_id, sku_version, active, changed_at)',
    );
    expect(result.sql).toContain(
      'INSERT INTO inventory.inventory_operations (id, operation_type, idempotency_key, intention, status',
    );
    expect(result.sql).toContain("'APLICADO'");
    expect(result.sql).toContain(
      'INSERT INTO inventory.reservations (id, reservation_id, status, expires_at, idempotency_key, intention, order_id, operation_id)',
    );
    expect(result.sql).toContain(
      `VALUES ('${result.expiredReservation.line_id}', '${result.expiredReservation.id}'`,
    );
    expect(result.cleanupSql).toContain(
      'DELETE FROM inventory.reservation_lines',
    );
    expect(result.cleanupSql).toContain('DELETE FROM inventory.locations');
  });

  it('verifica la integridad SHA-256 de los artefactos baseline versionados (verify)', async () => {
    const outDir = resolve(
      import.meta.dirname,
      '../../../../scripts/h5/fixtures/inventory/out',
    );
    const verified = await verifyGeneratedArtifacts(outDir, {
      seed: '20261126',
      profile: 'baseline',
    });
    expect(verified.manifest.profile).toBe('baseline');
    expect(verified.manifest.counts.balances).toBe(110);
  });

  it('impide cadenas de conexión hacia Supabase o entornos productivos/compartidos', () => {
    expect(() =>
      assertIsolatedDatabaseUrl(
        'postgresql://user:pass@db.abcdefg.supabase.co:5432/postgres',
      ),
    ).toThrow(/INV03_UNSAFE_DB_URL/);
    expect(() =>
      assertIsolatedDatabaseUrl(
        'postgresql://user:pass@prod-inventory.internal:5432/inventory',
      ),
    ).toThrow(/INV03_UNSAFE_DB_URL/);
    expect(() =>
      assertIsolatedDatabaseUrl(
        'postgresql://inventory_test:pass@127.0.0.1:5432/inventory_it',
      ),
    ).not.toThrow();
  });
});
