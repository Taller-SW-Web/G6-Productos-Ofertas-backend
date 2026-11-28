import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(import.meta.dirname, '../../../../');

describe('TAC-A03 / PERF-03 — Validación contractual del módulo k6 de disponibilidad comercial', () => {
  it('verifica que inventory-availability.k6.js es modular, read-only y no ejecuta POST /reservas', async () => {
    const k6Path = resolve(
      repoRoot,
      'scripts/h5/performance/inventory-availability.k6.js',
    );
    const source = await readFile(k6Path, 'utf8');

    // Parámetros configurables obligatorios según guía PERF-03
    expect(source).toContain('BASE_URL');
    expect(source).toContain('CHANNEL');
    expect(source).toContain('DATASET_MANIFEST');
    expect(source).toContain('AUTH_TOKEN');
    expect(source).toContain('PROFILE');
    expect(source).toContain('DURATION');

    // Perfiles oficiales H5-03 (1VU-60s, 5VU-180s, 20VU-300s) y validación estricta de VUs y duración
    expect(source).toContain('1VU-60s');
    expect(source).toContain('5VU-180s');
    expect(source).toContain('20VU-300s');
    expect(source).toContain('VUS !== expected.vus');
    expect(source).toContain('DURATION !== expected.duration');

    // Segregación de escenarios y métricas por operación
    expect(source).toContain('availability_get');
    expect(source).toContain('availability_verify_post');
    expect(source).toContain('h5_perf03_get_2xx_responses');
    expect(source).toContain('h5_perf03_verify_2xx_responses');
    expect(source).toContain('h5_perf03_rate_limited_429_responses');
    expect(source).toContain('h5_perf03_unexpected_error_rate');
    expect(source).toContain("['rate<0.01']");

    // Métricas por clase de respuesta HTTP (separadas según PERF-03)
    expect(source).toContain('h5_perf03_bad_request_400_responses');
    expect(source).toContain('h5_perf03_auth_rejected_responses');
    expect(source).toContain('h5_perf03_not_found_404_responses');
    expect(source).toContain('h5_perf03_unprocessable_422_responses');
    expect(source).toContain('h5_perf03_unavailable_503_responses');
    expect(source).toContain('h5_perf03_server_5xx_responses');

    // Distribución de SKU 60/15/10/10/5 sobre grupos reales (sin claves inexistentes ni canal alternativo)
    expect(source).toContain('60');
    expect(source).toContain('75');
    expect(source).toContain('85');
    expect(source).toContain('95');
    expect(source).toContain('SKUS_AVAILABLE');
    expect(source).toContain('SKUS_LOW_STOCK');
    expect(source).toContain('SKUS_ZERO');
    expect(source).toContain('SKUS_UNREGISTERED');
    expect(source).toContain('SKUS_NON_SELLABLE');

    expect(source).not.toContain('available_sku_02');
    expect(source).not.toContain('available_sku_03');
    expect(source).not.toContain('low_stock_sku_02');
    expect(source).not.toContain('alt_channel_sku');

    // Ruta correcta del manifest desde scripts/h5/performance/ hacia scripts/h5/fixtures/inventory/out/
    expect(source).toContain('../fixtures/inventory/out/manifest.json');
    expect(source).not.toContain('../../fixtures/inventory/out/manifest.json');

    // 1VU-60s no configura 2 VUs
    expect(source).toContain('totalVus === 1');

    // Endpoints de lectura exclusivamente
    expect(source).toContain('/api/v1/inventario/disponibilidad/comercial');
    expect(source).toContain(
      '/api/v1/inventario/disponibilidad/comercial/verificar',
    );
    // Prohibido mutar reservas durante benchmark de disponibilidad
    expect(source).not.toMatch(/\/api\/v1\/inventario\/reservas/);
  });

  it('verifica que el manifest baseline versionado coincide exactamente con manifest.sha256', async () => {
    const outDir = resolve(repoRoot, 'scripts/h5/fixtures/inventory/out');
    const manifestBytes = await readFile(
      resolve(outDir, 'manifest.json'),
      'utf8',
    );
    const shaFile = (
      await readFile(resolve(outDir, 'manifest.sha256'), 'utf8')
    ).trim();

    const actualSha = createHash('sha256').update(manifestBytes).digest('hex');
    expect(shaFile).toBe(`${actualSha}  manifest.json`);

    const parsed = JSON.parse(manifestBytes);
    expect(parsed.profile).toBe('baseline');
    expect(parsed.counts.skus).toBe(55);
    expect(parsed.counts.balances).toBe(110);
  });

  it('verifica que la distribución de SKU 60/15/10/10/5 usa exclusivamente claves existentes en manifest.json', async () => {
    const outDir = resolve(repoRoot, 'scripts/h5/fixtures/inventory/out');
    const manifest = JSON.parse(
      await readFile(resolve(outDir, 'manifest.json'), 'utf8'),
    );
    const mandatoryKeys = Object.keys(manifest.mandatory_groups);

    const k6Path = resolve(
      repoRoot,
      'scripts/h5/performance/inventory-availability.k6.js',
    );
    const source = await readFile(k6Path, 'utf8');

    const referencedKeys = [
      'threshold_plus_one_sku',
      'partial_reserved_sku',
      'exact_threshold_sku',
      'with_blocked_sku',
      'available_zero_sku',
      'reserved_zero_available_sku',
      'unregistered_sku',
      'deactivated_catalog_sku',
    ];
    for (const key of referencedKeys) {
      expect(mandatoryKeys).toContain(key);
      expect(source).toContain(key);
    }

    // La distribución del summary incluye los porcentajes explícitos (5% = non_sellable)
    expect(source).toContain('available: 60');
    expect(source).toContain('low_stock: 15');
    expect(source).toContain('zero: 10');
    expect(source).toContain('unregistered: 10');
    expect(source).toContain('non_sellable: 5');
  });
});
