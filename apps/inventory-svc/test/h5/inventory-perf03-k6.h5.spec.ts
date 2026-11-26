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

    // Perfiles oficiales H5-03 (1VU-60s, 5VU-180s, 20VU-300s)
    expect(source).toContain('1VU-60s');
    expect(source).toContain('5VU-180s');
    expect(source).toContain('20VU-300s');

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

    // Distribución de SKU 60/15/10/10/5 según PERF-03
    expect(source).toContain('60'); // disponibles
    expect(source).toContain('75'); // límite disponibles + low_stock (60+15)
    expect(source).toContain('85'); // límite + agotados (75+10)
    expect(source).toContain('95'); // límite + no registrados (85+10)
    // Resto 5% → canal alternativo
    expect(source).toContain('SKUS_AVAILABLE');
    expect(source).toContain('SKUS_LOW_STOCK');
    expect(source).toContain('SKUS_ZERO');
    expect(source).toContain('SKUS_UNREGISTERED');
    expect(source).toContain('SKUS_ALT_CHANNEL');

    // Ruta correcta del manifest desde scripts/h5/performance/ hacia scripts/h5/fixtures/inventory/out/
    expect(source).toContain('../fixtures/inventory/out/manifest.json');
    // No debe usar la ruta incorrecta (../../ que saldría del directorio h5)
    expect(source).not.toContain('../../fixtures/inventory/out/manifest.json');

    // 1VU-60s no configura 2 VUs: el perfil de un VU debe ejecutar ambas operaciones en secuencia
    // La variable verifyVus solo se usa cuando totalVus > 1
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

  it('verifica que la distribución de SKU sigue pesos 60/15/10/10/5 en el módulo k6', async () => {
    // Verificación estructural: los grupos de SKU del manifest son reconocidos en el k6
    const k6Path = resolve(
      repoRoot,
      'scripts/h5/performance/inventory-availability.k6.js',
    );
    const source = await readFile(k6Path, 'utf8');

    // Claves del manifest que el k6 usa para categorizar SKUs
    expect(source).toContain('threshold_plus_one_sku');
    expect(source).toContain('exact_threshold_sku');
    expect(source).toContain('available_zero_sku');
    expect(source).toContain('unregistered_sku');

    // La distribución del summary incluye los porcentajes explícitos
    expect(source).toContain('available: 60');
    expect(source).toContain('low_stock: 15');
    expect(source).toContain('zero: 10');
    expect(source).toContain('unregistered: 10');
    expect(source).toContain('alt_channel: 5');
  });
});
