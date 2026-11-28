import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { type PostgresSettings } from '../../src/database.js';
import { CatalogGatewayHarness } from '../support/catalog-gateway-harness.js';
import { executeSuite } from '../../../../tests/h5/postman/scripts/run-newman.mjs';

/**
 * H19 — Integración local real: ejecuta Newman contra los servicios productivos reales
 * (api-gateway + catalog-svc) respaldados por PostgreSQL 17 descartable y JWKS RS256 sintético.
 *
 * Nivel de evidencia: PASS / ISOLATED (servicios reales + PostgreSQL 17 descartable).
 */

const RUN_PG = process.env.CATALOG_H5_DISPOSABLE_PG === '1';

function buildLocalPgSettings(): PostgresSettings {
  const host = process.env.PGHOST || '127.0.0.1';
  const port = Number(process.env.PGPORT || '55432');
  const database = process.env.PGDATABASE || 'h5_catalog_isolated';
  const user = process.env.PGUSER || 'catalog_app';
  const password = process.env.PGPASSWORD || 'app_pass';
  return {
    expectedRole: user,
    database,
    user,
    password,
    mode: 'direct',
    pool: { host, port, database, user, password, max: 6, idleTimeoutMillis: 10000 },
  };
}

describe.runIf(RUN_PG)(
  'H19 — Newman contra api-gateway + catalog-svc productivos reales y PostgreSQL 17 descartable',
  () => {
    const harness = new CatalogGatewayHarness();

    beforeAll(async () => {
      await harness.start(buildLocalPgSettings());
    }, 90000);

    afterAll(async () => {
      await harness.close();
    }, 20000);

    it('ejecuta carpeta 00 (Preflight Gateway /health y /health/ready) y carpeta 09 (negativos 401/404/400) contra servicios reales', async () => {
      const token = harness.token();
      const outDir = mkdtempSync(join(tmpdir(), 'g6-h19-real-'));
      try {
        // 1) Preflight real contra api-gateway productivo:
        // PM-001 (/health) -> 200 PASS; PM-001B (/health/ready) -> 503 not_ready (esperado cuando solo catalog-svc esta levantado)
        const preflightRes = await executeSuite({
          env: 'local',
          baseUrl: harness.gatewayOrigin,
          folder: '00 - Preflight y autenticacion',
          runId: 'h19-real-gateway-preflight',
          outDir,
          allowNoAuth: true,
          evidenceLevel: 'ISOLATED',
          skipSecretScan: true,
        });
        expect(preflightRes.totals.pass).toBe(1);
        expect(preflightRes.totals.fail).toBe(1);

        // 2) Casos negativos contractuales reales contra api-gateway -> catalog-svc -> PostgreSQL 17
        const negRes = await executeSuite({
          env: 'local',
          baseUrl: harness.gatewayOrigin,
          folder: '09 - APIM, Gateway y G7',
          runId: 'h19-real-gateway-catalog-negatives',
          outDir,
          accessToken: token,
          restrictedAccessToken: '', // price-audit-svc no levantado en este scope; PM-005 queda NOT_RUN
          evidenceLevel: 'ISOLATED',
          skipSecretScan: true,
        });
        // 6 casos ejecutados reales (PM-004, PM-004B, PM-006, PM-007A, PM-007B, PM-008) PASS + PM-005 NOT_RUN
        expect(negRes.totals.fail).toBe(0);
        expect(negRes.totals.pass).toBe(6);
        expect(negRes.totals.notRunPmCases).toBe(1);
        expect(negRes.overallVerdict).toBe('PARTIAL_NOT_COMPLETE');
        expect(negRes.exitCode).toBe(5);
      } finally {
        rmSync(outDir, { recursive: true, force: true });
      }
    }, 60000);
  },
);
