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

    // Segregación de escenarios, métricas por operación, 429 y umbral < 1%
    expect(source).toContain('availability_get');
    expect(source).toContain('availability_verify_post');
    expect(source).toContain('h5_perf03_get_2xx_responses');
    expect(source).toContain('h5_perf03_verify_2xx_responses');
    expect(source).toContain('h5_perf03_rate_limited_429_responses');
    expect(source).toContain('h5_perf03_unexpected_error_rate');
    expect(source).toContain("['rate<0.01']");

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
});
