import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { catalogCorrelation } from '../../src/bootstrap.js';
import { AppModule as CatalogAppModule } from '../../src/app.module.js';
import { CATALOG_SECURITY_CONFIG } from '../../src/catalog-auth.js';
import { CATALOG_AMQP_SETTINGS } from '../../src/catalog-amqp.js';
import { CATALOG_TAXONOMY_CONFIG } from '../../src/taxonomy-config.js';
import { CATALOG_TAXONOMY_IDENTITY } from '../../src/catalog-master.client.js';
import { CATALOG_PRICING_IDENTITY } from '../../src/catalog-price-filter.js';
import { CatalogConfig } from '../../src/config.js';
import { Database } from '../../src/database.js';
import { CATALOG_READ_DEMO } from '../../src/catalog-read-demo.js';
import { CATALOG_PREPARATION_CONFIG } from '../../src/catalog-messages.js';
import {
  HISTORICAL_PRICING_CONTRACT,
  HISTORICAL_RECOVERY_CAPABILITIES,
  readHistoricalRecoveryCapabilities,
} from '../../src/historical-recovery.service.js';
import { readHistoricalPricingContract } from '../../src/historical-pricing.contract.js';
import {
  readSafeDisposablePg17Settings,
  verifyDisposablePg17Contract,
} from './disposable-pg17.helper.js';

import { PricingSvcModule } from '../../../pricing-svc/src/pricing-svc.module.js';
import { PRICING_CATALOG_TOKEN } from '../../../pricing-svc/src/http/catalog-context.js';
import { InventorySvcModule } from '../../../inventory-svc/src/inventory-svc.module.js';
import { executeSuite } from '../../../../tests/h5/postman/scripts/run-newman.mjs';

/**
 * H26 + H27 — Integración local positiva y negativa con servicios productivos reales:
 *   api-gateway -> catalog-svc -> pricing-svc + inventory-svc -> PostgreSQL 17 descartable
 *   con JWKS RS256 sintético local (sin tocar infraestructura compartida ni APIM/ACA/G7).
 *
 * Nivel de evidencia: PASS / ISOLATED (servicios reales + PostgreSQL 17 descartable).
 *
 * Cobertura real Newman verificada:
 *   - Carpeta 00: PM-001 (/health 200 PASS), PM-001B (/health/ready 503 FAIL honesto porque
 *     los otros servicios como bulk/combos/promotions/price-audit no están levantados).
 *   - Carpeta 01 (positiva real): PM-002, PM-003A, PM-003B, PM-003C, PM-003D (Catalog -> Pricing
 *     HTTP real con producto simple + producto multi-variante sobre PostgreSQL 17).
 *   - Carpeta 02 (positiva y negativa real Inventory): 4 escenarios de Defecto B / H18 contra
 *     inventory-svc real + PostgreSQL 17 (1 ubicación sin location_id -> 200; multi-ubicación sin
 *     location_id -> 400 VALIDACION; multi-ubicación con location_id UUID explícito -> 200;
 *     ubicación sin saldo -> 200 items[]).
 *   - Carpeta 09 (negativos reales): PM-004, PM-004B, PM-006, PM-007A, PM-007B, PM-008 PASS;
 *     PM-005 NOT_RUN (price-audit-svc fuera de este alcance).
 */

const RUN_PG = process.env.CATALOG_H5_DISPOSABLE_PG === '1';

const LOC_LIMA_ID = '00000000-0000-4000-8000-000000000101';
const LOC_AREQUIPA_ID = '00000000-0000-4000-8000-000000000102';
const LOC_SIN_SALDO_ID = '00000000-0000-4000-8000-000000000199';

const SIMPLE_PROD_ID = '00000000-0000-4000-8000-000000000501';
const SIMPLE_SKU = 'SKU-H27-SIMPLE-001';

const MULTI_PROD_ID = '00000000-0000-4000-8000-000000000502';
const MULTI_SKU_BASE = 'SKU-H27-MULTI-BASE';
const MULTI_VAR_EXPENSIVE_ID = '00000000-0000-4000-8000-000000000511';
const MULTI_VAR_EXPENSIVE_SKU = 'SKU-H27-VAR-EXPENSIVE';
const MULTI_VAR_ELIGIBLE_ID = '00000000-0000-4000-8000-000000000512';
const MULTI_VAR_ELIGIBLE_SKU = 'SKU-H27-VAR-ELIGIBLE';

describe.runIf(RUN_PG)(
  'H26 + H27 — Newman contra api-gateway + catalog-svc + pricing-svc + inventory-svc productivos reales sobre PostgreSQL 17 descartable',
  () => {
    const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
    let jwksServer: Server | undefined;
    let jwksOrigin = '';
    let pricingApp: INestApplication | undefined;
    let inventoryApp: INestApplication | undefined;
    let catalogApp: INestApplication | undefined;
    let gatewayProc: ChildProcess | undefined;
    let gatewayDir = '';
    let gatewayOrigin = '';
    let database: Database | undefined;

    const savedEnv: Record<string, string | undefined> = {};

    function signJwt(claims: Record<string, unknown>): string {
      const now = Math.floor(Date.now() / 1000);
      const header = Buffer.from(
        JSON.stringify({ alg: 'RS256', kid: 'h27-local-fixture' }),
      ).toString('base64url');
      const payload = Buffer.from(
        JSON.stringify({
          iss: jwksOrigin,
          iat: now - 5,
          exp: now + 600,
          jti: randomUUID(),
          ...claims,
        }),
      ).toString('base64url');
      const sig = sign(
        'RSA-SHA256',
        Buffer.from(`${header}.${payload}`),
        keys.privateKey,
      ).toString('base64url');
      return `${header}.${payload}.${sig}`;
    }

    function userToken(): string {
      return signJwt({
        sub: '00000000-0000-4000-8000-000000000050',
        tipo: 'acceso',
        aud: 'api-productos',
        roles: ['GESTOR_COMERCIAL', 'ADMINISTRADOR'],
      });
    }

    function catalogToPricingToken(): string {
      return signJwt({
        sub: 'modulo-productos',
        tipo: 'servicio',
        aud: 'api-productos',
        scope: 'precios:leer catalogo:leer',
      });
    }

    beforeAll(async () => {
      // 1) H26: Validar contrato seguro de PostgreSQL 17 descartable (loopback, *_isolated, rol runtime no-owner, PG17, migraciones)
      const pgSettings = readSafeDisposablePg17Settings();
      database = new Database(pgSettings);
      const pgCheck = await verifyDisposablePg17Contract(database);
      expect(pgCheck.serverVersionNum).toBeGreaterThanOrEqual(170000);
      expect(pgCheck.serverVersionNum).toBeLessThan(180000);

      const pgHost = pgSettings.pool.host || '127.0.0.1';
      const pgPort = pgSettings.pool.port || 55432;
      const pgDb = pgSettings.database;
      const adminPass = process.env.PGADMIN_PASSWORD || 'postgres';

      // 2) Sembrar fixtures deterministas en los 3 esquemas reales (catalog, pricing, inventory)
      const adminPool = new pg.Pool({
        host: pgHost,
        port: pgPort,
        database: pgDb,
        user: 'postgres',
        password: adminPass,
      });
      try {
        // Limpiar tablas en la BD descartable aislada (TRUNCATE evita triggers de inmutabilidad en DELETE fila a fila)
        await adminPool.query(
          `TRUNCATE catalog.activation_checks, catalog.sku_identity, catalog.product_images, catalog.product_identifying_characteristics, catalog.variants, catalog.products RESTART IDENTITY CASCADE`,
        );
        await adminPool.query(
          `TRUNCATE pricing.price_validities, pricing.prices RESTART IDENTITY CASCADE`,
        );
        await adminPool.query(
          `DELETE FROM inventory.stock_balance WHERE sku_id IN ($1, $2, $3)`,
          [SIMPLE_SKU, MULTI_VAR_EXPENSIVE_SKU, MULTI_VAR_ELIGIBLE_SKU],
        );

        // Catalog: insertar en transacción única respetando todas las invariantes del trigger diferido fn_assert_product
        const seedClient = await adminPool.connect();
        try {
          await seedClient.query('BEGIN');
          await seedClient.query(
            `INSERT INTO catalog.products
               (id, nombre, descripcion, categoria_id, tipo_producto_id, marca_id, sku_base, slug, tiene_variantes, estado, publicado_alguna_vez, catalog_version)
             VALUES
               ($1, 'Camiseta H27 Simple', 'Producto simple real H27', 'cat-h27', 'type-h27', 'brand-h27', $3, 'camiseta-h27-simple', false, 'ACTIVO', true, 1),
               ($2, 'Zapatilla H27 Multi', 'Producto multi-variante real H27', 'cat-h27', 'type-h27', 'brand-h27', $4, 'zapatilla-h27-multi', true, 'ACTIVO', true, 1)`,
            [SIMPLE_PROD_ID, MULTI_PROD_ID, SIMPLE_SKU, MULTI_SKU_BASE],
          );
          await seedClient.query(
            `INSERT INTO catalog.product_identifying_characteristics (product_id, caracteristica_id)
             VALUES ($1, 'talla')`,
            [MULTI_PROD_ID],
          );
          await seedClient.query(
            `INSERT INTO catalog.variants
               (id, product_id, sku, identifying_key, estado, catalog_version)
             VALUES
               ($1, $3, $4, '{"talla":{"valor":"42"}}'::jsonb, 'ACTIVA', 1),
               ($2, $3, $5, '{"talla":{"valor":"40"}}'::jsonb, 'ACTIVA', 1)`,
            [
              MULTI_VAR_EXPENSIVE_ID,
              MULTI_VAR_ELIGIBLE_ID,
              MULTI_PROD_ID,
              MULTI_VAR_EXPENSIVE_SKU,
              MULTI_VAR_ELIGIBLE_SKU,
            ],
          );
          await seedClient.query(
            `INSERT INTO catalog.variant_attribute_values
               (variant_id, caracteristica_id, nombre_snapshot, valor_id, valor, es_identificador)
             VALUES
               ($1, 'talla', 'Talla', NULL, '"42"'::jsonb, true),
               ($2, 'talla', 'Talla', NULL, '"40"'::jsonb, true)`,
            [MULTI_VAR_EXPENSIVE_ID, MULTI_VAR_ELIGIBLE_ID],
          );
          await seedClient.query(
            `INSERT INTO catalog.variant_images (variant_id, url, posicion)
             VALUES
               ($1, 'https://cdn.example.test/h27-var-42.jpg', 0),
               ($2, 'https://cdn.example.test/h27-var-40.jpg', 0)`,
            [MULTI_VAR_EXPENSIVE_ID, MULTI_VAR_ELIGIBLE_ID],
          );
          const skuIdsRes = await seedClient.query<{ id: string; sku: string }>(
            `SELECT id, sku FROM catalog.sku_identity
             WHERE sku IN ($1, $2, $3)`,
            [SIMPLE_SKU, MULTI_VAR_EXPENSIVE_SKU, MULTI_VAR_ELIGIBLE_SKU],
          );
          for (const row of skuIdsRes.rows) {
            await seedClient.query(
              `INSERT INTO catalog.sku_physical_profiles (sku_identity_id, peso_kg, largo_cm, ancho_cm, alto_cm)
               VALUES ($1, 0.5, 30, 20, 10)`,
              [row.id],
            );
          }
          await seedClient.query(
            `INSERT INTO catalog.product_images (product_id, url, principal, posicion)
             VALUES
               ($1, 'https://cdn.example.test/h27-simple.jpg', true, 0),
               ($2, 'https://cdn.example.test/h27-multi.jpg', true, 0)`,
            [SIMPLE_PROD_ID, MULTI_PROD_ID],
          );
          for (const [productId, variantId, sku, dep] of [
            [SIMPLE_PROD_ID, null, SIMPLE_SKU, 'PRICING'],
            [SIMPLE_PROD_ID, null, SIMPLE_SKU, 'INVENTORY'],
            [MULTI_PROD_ID, null, MULTI_SKU_BASE, 'PRICING'],
            [
              MULTI_PROD_ID,
              MULTI_VAR_EXPENSIVE_ID,
              MULTI_VAR_EXPENSIVE_SKU,
              'INVENTORY',
            ],
            [
              MULTI_PROD_ID,
              MULTI_VAR_ELIGIBLE_ID,
              MULTI_VAR_ELIGIBLE_SKU,
              'INVENTORY',
            ],
          ] as const) {
            await seedClient.query(
              `INSERT INTO catalog.activation_checks
                 (product_id, variant_id, sku, dependency, operation_id, correlation_id, request_payload, state, result_payload, result_message_id)
               VALUES ($1, $2, $3, $4, $5, $6, '{}'::jsonb, 'COMPLETED', '{"ok":true}'::jsonb, $7)`,
              [
                productId,
                variantId,
                sku,
                dep,
                randomUUID(),
                randomUUID(),
                randomUUID(),
              ],
            );
          }
          await seedClient.query('COMMIT');
        } catch (err) {
          await seedClient.query('ROLLBACK').catch(() => undefined);
          throw err;
        } finally {
          seedClient.release();
        }

        // Pricing: precios vigentes reales (producto simple por product_id; multi-variante por base + SKU override)
        // SIMPLE_PROD_ID = 45.00; MULTI_PROD_ID base = 150.00; VAR_EXPENSIVE = 150.00; VAR_ELIGIBLE = 50.00
        const validFrom = new Date(Date.now() - 3600_000).toISOString();
        const pricingClient = await adminPool.connect();
        try {
          await pricingClient.query('BEGIN');
          for (const [productId, sku, regular] of [
            [SIMPLE_PROD_ID, null, '45.00'],
            [MULTI_PROD_ID, null, '150.00'],
            [null, MULTI_VAR_EXPENSIVE_SKU, '150.00'],
            [null, MULTI_VAR_ELIGIBLE_SKU, '50.00'],
          ] as const) {
            const priceRes = await pricingClient.query<{ id: string }>(
              `INSERT INTO pricing.prices (product_id, sku, channel_id, price_version)
               VALUES ($1, $2, NULL, 1) RETURNING id`,
              [productId, sku],
            );
            await pricingClient.query(
              `INSERT INTO pricing.price_validities
                 (price_id, precio_regular, precio_oferta, currency, valid_from, valid_until, price_version, motivo_cambio, usuario_id)
               VALUES ($1, $2::numeric, NULL, 'PEN', $3::timestamptz, NULL, 1, 'Seed H27 integracion local', 'h27-seed')`,
              [priceRes.rows[0].id, regular, validFrom],
            );
          }
          await pricingClient.query('COMMIT');
        } catch (err) {
          await pricingClient.query('ROLLBACK').catch(() => undefined);
          throw err;
        } finally {
          pricingClient.release();
        }

        // Inventory: 3 ubicaciones reales
        await adminPool.query(
          `INSERT INTO inventory.locations (id, code, name, type, active)
           VALUES
             ($1, 'H27-LIMA-01', 'Almacen H27 Lima Norte', 'ALMACEN', true),
             ($2, 'H27-AQP-02', 'Almacen H27 Arequipa', 'ALMACEN', true),
             ($3, 'H27-EMPTY-99', 'Almacen H27 Sin Saldo', 'ALMACEN', true)
           ON CONFLICT (id) DO NOTHING`,
          [LOC_LIMA_ID, LOC_AREQUIPA_ID, LOC_SIN_SALDO_ID],
        );
        // SIMPLE_SKU en 1 sola ubicación (LOC_LIMA_ID) -> consulta sin location_id devuelve 200
        // MULTI_VAR_ELIGIBLE_SKU en 2 ubicaciones (LOC_LIMA_ID + LOC_AREQUIPA_ID) -> sin location_id devuelve 400 VALIDACION; con location_id devuelve 200; con LOC_SIN_SALDO_ID devuelve 200 items=[]
        await adminPool.query(
          `INSERT INTO inventory.stock_balance (sku_id, location_id, on_hand, reserved, blocked, stock_version)
           VALUES
             ($1, $3, 20, 2, 1, 1),
             ($2, $3, 30, 5, 0, 1),
             ($2, $4, 12, 0, 2, 1)`,
          [SIMPLE_SKU, MULTI_VAR_ELIGIBLE_SKU, LOC_LIMA_ID, LOC_AREQUIPA_ID],
        );
      } finally {
        await adminPool.end();
      }

      // 3) Servidor JWKS RS256 + Taxonomy fixture local
      jwksServer = createServer((req, res) => {
        res.setHeader('content-type', 'application/json');
        res.setHeader('cache-control', 'max-age=60');
        const urlPath = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
        if (urlPath === '/discovery') {
          res.end(
            JSON.stringify({
              issuer: jwksOrigin,
              jwks_uri: `${jwksOrigin}/jwks`,
            }),
          );
          return;
        }
        if (urlPath === '/jwks') {
          res.end(
            JSON.stringify({
              keys: [
                {
                  ...keys.publicKey.export({ format: 'jwk' }),
                  kid: 'h27-local-fixture',
                  alg: 'RS256',
                  use: 'sig',
                },
              ],
            }),
          );
          return;
        }
        if (urlPath === '/api/v1/marcas/brand-h27') {
          res.end(
            JSON.stringify({
              marcaId: 'brand-h27',
              nombre: 'Marca H27',
              estado: 'ACTIVO',
              version: 1,
            }),
          );
          return;
        }
        if (urlPath === '/api/v1/marcas') {
          res.end(
            JSON.stringify({
              brands: [
                {
                  marca_id: 'brand-h27',
                  name: 'Marca H27',
                  status: 'ACTIVA',
                },
              ],
            }),
          );
          return;
        }
        if (urlPath === '/api/v1/categorias/cat-h27') {
          res.end(
            JSON.stringify({
              categoriaId: 'cat-h27',
              nombre: 'Categoria H27',
              estado: 'ACTIVO',
              version: 1,
            }),
          );
          return;
        }
        res.statusCode = 404;
        res.end('{}');
      });
      jwksServer.listen(0, '127.0.0.1');
      await once(jwksServer, 'listening');
      const jwksAddr = jwksServer.address();
      if (!jwksAddr || typeof jwksAddr === 'string') {
        throw new Error('JWKS server did not bind loopback');
      }
      jwksOrigin = `http://127.0.0.1:${jwksAddr.port}`;

      // 4) Levantar catalog-svc PRODUCTIVO REAL primero (con pricingOrigin resuelto dinámicamente al arrancar pricing-svc)
      let pricingOrigin = '';
      const catalogConfig = {
        environment: 'test',
        port: 3001,
        host: '127.0.0.1',
        database: pgSettings,
        taxonomy: { origin: jwksOrigin },
        security: {
          issuer: jwksOrigin,
          discoveryUrl: `${jwksOrigin}/discovery`,
          jwksUrl: `${jwksOrigin}/jwks`,
        },
        amqp: {},
        preparation: {},
        readDemo: {
          enabled: false,
          restricted: false,
          gatewayIps: ['127.0.0.1'],
        },
        historicalRecoveryCapabilities: readHistoricalRecoveryCapabilities({}),
        historicalPricingContract: readHistoricalPricingContract({
          NODE_ENV: 'test',
          CATALOG_HISTORICAL_PRICING_CANDIDATE_ENABLED: 'false',
        }),
        get pricingOrigin() {
          return pricingOrigin;
        },
      } as unknown as CatalogConfig;

      const catalogMod = await Test.createTestingModule({
        imports: [CatalogAppModule.forRoot(catalogConfig)],
      })
        .overrideProvider(CATALOG_TAXONOMY_IDENTITY)
        .useValue({
          authorization: async () => `Bearer ${catalogToPricingToken()}`,
        })
        .overrideProvider(CATALOG_PRICING_IDENTITY)
        .useValue({
          authorization: async () => `Bearer ${catalogToPricingToken()}`,
        })
        .overrideProvider(Database)
        .useValue(database)
        .compile();

      catalogApp = catalogMod.createNestApplication({ logger: false });
      catalogApp.use(catalogCorrelation);
      await catalogApp.listen(0, '127.0.0.1');
      const catalogOrigin = await catalogApp.getUrl();

      // 5) Levantar pricing-svc PRODUCTIVO REAL apuntando a catalog-svc REAL y PostgreSQL 17 (rol runtime pricing_app)
      const pricingUser = process.env.PRICING_RUNTIME_USER || 'pricing_app';
      const pricingPass =
        process.env.PRICING_RUNTIME_PASSWORD ||
        pgSettings.password ||
        'app_pass';
      const pricingEnv: NodeJS.ProcessEnv = {
        NODE_ENV: 'test',
        PRICING_SVC_PORT: '3004',
        G6_SECURITY_MODE: 'G7_AUTHENTICATED',
        DATABASE_URL: `postgresql://${pricingUser}:${pricingPass}@${pgHost}:${pgPort}/${pgDb}?sslmode=disable`,
        AUTH_ISSUER: jwksOrigin,
        AUTH_JWKS_URL: `${jwksOrigin}/jwks`,
        PRICING_CATALOG_URL: catalogOrigin,
      };
      const pricingMod = await Test.createTestingModule({
        imports: [PricingSvcModule.forRoot(pricingEnv)],
      })
        .overrideProvider(PRICING_CATALOG_TOKEN)
        .useValue(async () => catalogToPricingToken())
        .compile();
      pricingApp = pricingMod.createNestApplication({ logger: false });
      await pricingApp.listen(0, '127.0.0.1');
      pricingOrigin = await pricingApp.getUrl();

      // 6) Levantar inventory-svc PRODUCTIVO REAL sobre PostgreSQL 17 con rol runtime no propietario (inventory_app, NUNCA postgres)
      const inventoryUser =
        process.env.INVENTORY_RUNTIME_USER || 'inventory_app';
      const inventoryPass =
        process.env.INVENTORY_RUNTIME_PASSWORD ||
        pgSettings.password ||
        'app_pass';
      if (inventoryUser === 'postgres' || inventoryUser.includes('owner')) {
        throw new Error(
          `H33 SEGURIDAD: inventory-svc debe ejecutarse con rol runtime no propietario (recibido: ${inventoryUser}).`,
        );
      }
      const envKeys = [
        'NODE_ENV',
        'G6_SECURITY_MODE',
        'G7_JWT_ISSUER',
        'G7_JWT_JWKS_URL',
        'DATABASE_URL',
        'PGHOST',
        'PGPORT',
        'PGDATABASE',
        'PGUSER',
        'PGPASSWORD',
        'PGSSLMODE',
        'INVENTORY_SVC_PORT',
      ];
      for (const k of envKeys) savedEnv[k] = process.env[k];
      process.env.NODE_ENV = 'test';
      process.env.G6_SECURITY_MODE = 'G7_AUTHENTICATED';
      process.env.G7_JWT_ISSUER = jwksOrigin;
      process.env.G7_JWT_JWKS_URL = `${jwksOrigin}/jwks`;
      process.env.DATABASE_URL = `postgresql://${inventoryUser}:${inventoryPass}@${pgHost}:${pgPort}/${pgDb}?sslmode=disable`;
      delete process.env.PGHOST;
      delete process.env.PGPORT;
      delete process.env.PGDATABASE;
      delete process.env.PGUSER;
      delete process.env.PGPASSWORD;
      process.env.PGSSLMODE = 'disable';
      process.env.INVENTORY_SVC_PORT = '3005';

      const invMod = await Test.createTestingModule({
        imports: [InventorySvcModule],
      }).compile();
      inventoryApp = invMod.createNestApplication({ logger: false });
      await inventoryApp.listen(0, '127.0.0.1');
      const inventoryOrigin = await inventoryApp.getUrl();

      // 7) Levantar api-gateway PRODUCTIVO REAL enlazando los 3 microservicios productivos reales
      gatewayDir = mkdtempSync(join(tmpdir(), 'h27-real-gateway-'));
      const compiledDir = join(gatewayDir, 'compiled');
      const compile = spawnSync(
        process.execPath,
        [
          resolve('node_modules/typescript/bin/tsc'),
          '-p',
          resolve('apps/api-gateway/tsconfig.app.json'),
          '--outDir',
          compiledDir,
          '--composite',
          'false',
          '--declaration',
          'false',
          '--incremental',
          'false',
        ],
        { encoding: 'utf8', timeout: 60000, windowsHide: true },
      );
      if (compile.status !== 0) {
        throw new Error(
          `Gateway compilation failed: ${compile.stdout}\n${compile.stderr}`,
        );
      }
      symlinkSync(
        resolve('node_modules'),
        join(gatewayDir, 'node_modules'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      const asUrl = (p: string) => JSON.stringify(pathToFileURL(p).href);
      const settings = {
        upstreams: {
          'catalog-svc': catalogOrigin,
          'pricing-svc': pricingOrigin,
          'inventory-svc': inventoryOrigin,
          'taxonomy-svc': jwksOrigin,
        },
        issuer: jwksOrigin,
        jwksUrl: `${jwksOrigin}/jwks`,
        timeoutMs: 10000,
        maxBytes: 1024 * 1024,
        publicOperations: [],
        demoNoAuthEnabled: false,
      };
      const bootCode = `
        import { Test } from ${asUrl(resolve('node_modules/@nestjs/testing/index.js'))};
        import { ApiGatewayModule } from ${asUrl(join(compiledDir, 'api-gateway.module.js'))};
        import { GATEWAY_SETTINGS } from ${asUrl(join(compiledDir, 'routing/gateway-settings.js'))};
        const mod = await Test.createTestingModule({ imports: [ApiGatewayModule] })
          .overrideProvider(GATEWAY_SETTINGS)
          .useValue(${JSON.stringify(settings)})
          .compile();
        const app = mod.createNestApplication({ bodyParser: false, logger: false });
        app.enableShutdownHooks();
        await app.listen(0, '127.0.0.1');
        console.log('GATEWAY_READY=' + await app.getUrl());
      `;
      gatewayProc = spawn(
        process.execPath,
        ['--input-type=module', '-e', bootCode],
        {
          cwd: gatewayDir,
          windowsHide: true,
          env: {
            PATH: process.env.PATH,
            SystemRoot: process.env.SystemRoot,
            NODE_ENV: 'test',
          },
        },
      );
      let out = '';
      let errOut = '';
      gatewayProc.stdout?.on('data', (c) => {
        out += String(c);
      });
      gatewayProc.stderr?.on('data', (c) => {
        errOut += String(c);
      });
      const deadline = Date.now() + 25000;
      while (Date.now() < deadline) {
        const match = /GATEWAY_READY=(http:\/\/127\.0\.0\.1:\d+)/.exec(out);
        if (match) {
          gatewayOrigin = match[1];
          break;
        }
        if (gatewayProc.exitCode !== null) {
          throw new Error(
            `api-gateway exited early (${gatewayProc.exitCode}): ${errOut}`,
          );
        }
        await pause(100);
      }
      if (!gatewayOrigin) {
        throw new Error(
          `api-gateway did not report ready URL. stdout=${out} stderr=${errOut}`,
        );
      }
    }, 120000);

    afterAll(async () => {
      if (gatewayProc && gatewayProc.exitCode === null) {
        gatewayProc.kill();
      }
      if (catalogApp) await catalogApp.close().catch(() => undefined);
      if (inventoryApp) await inventoryApp.close().catch(() => undefined);
      if (pricingApp) await pricingApp.close().catch(() => undefined);
      if (database) await database.onModuleDestroy().catch(() => undefined);
      if (jwksServer) {
        jwksServer.close();
      }
      if (gatewayDir) {
        rmSync(gatewayDir, { recursive: true, force: true });
      }
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }, 30000);

    function allocateOutDir(prefix: string): { outDir: string; keep: boolean } {
      const keepBase = process.env.G6_H5_KEEP_EVIDENCE_DIR?.trim();
      if (keepBase) {
        return { outDir: resolve(keepBase), keep: true };
      }
      return { outDir: mkdtempSync(join(tmpdir(), prefix)), keep: false };
    }

    function readCaseById(
      evidenceDir: string,
      pmId: string,
    ): {
      pmId: string;
      status: string;
      httpStatus: number | null;
      url: string;
      assertions: Array<{
        name: string;
        passed: boolean;
        errorMessage: string | null;
      }>;
    } {
      const results = JSON.parse(
        readFileSync(join(evidenceDir, 'integration-results.json'), 'utf8'),
      ) as {
        cases: Array<{
          pmId: string;
          status: string;
          httpStatus: number | null;
          url: string;
          assertions: Array<{
            name: string;
            passed: boolean;
            errorMessage: string | null;
          }>;
        }>;
      };
      const found = results.cases.find((c) => c.pmId === pmId);
      if (!found) {
        throw new Error(
          `H34: Caso ${pmId} ausente en integration-results.json (${evidenceDir}).`,
        );
      }
      return found;
    }

    it('H27 positivo real (Carpeta 01): PM-002, PM-003A, PM-003B, PM-003C y PM-003D aprueban contra Gateway -> Catalog -> Pricing reales en PG17', async () => {
      const { outDir, keep } = allocateOutDir('g6-h27-cat-pricing-');
      try {
        const res = await executeSuite({
          env: 'local',
          baseUrl: gatewayOrigin,
          folder: '01 - Catalog y Pricing',
          runId: 'h27-real-catalog-pricing',
          outDir,
          accessToken: userToken(),
          evidenceLevel: 'ISOLATED',
          skipSecretScan: true,
        });

        expect(res.ok).toBe(true);
        expect(res.overallVerdict).toBe('PASS');
        expect(res.totals.pass).toBe(5);
        expect(res.totals.fail).toBe(0);
        expect(res.totals.notRunPmCases).toBe(0);
        expect(res.exitCode).toBe(0);
        for (const id of [
          'PM-002',
          'PM-003A',
          'PM-003B',
          'PM-003C',
          'PM-003D',
        ]) {
          const c = readCaseById(res.evidenceDir, id);
          expect(c.status).toBe('PASS');
          expect(c.httpStatus).toBe(200);
        }
      } finally {
        if (!keep) rmSync(outDir, { recursive: true, force: true });
      }
    }, 60000);

    it('H27 + H34 positivo/negativo real Inventory (Carpeta 02): verifica PM-010, PM-011 y PM-012 individualmente en los 4 escenarios contra inventory-svc real en PG17', async () => {
      const token = userToken();

      // Escenario 1: SKU con 1 sola ubicación (SIMPLE_SKU) sin location_id -> PM-010/011/012 HTTP 200 PASS + SKU esperado
      {
        const { outDir, keep } = allocateOutDir('g6-h27-inv-single-');
        try {
          const res = await executeSuite({
            env: 'local',
            baseUrl: gatewayOrigin,
            folder: '02 - Preparacion comercial e Inventory',
            runId: 'h27-real-inv-single-loc',
            outDir,
            accessToken: token,
            productId: SIMPLE_PROD_ID,
            sku: SIMPLE_SKU,
            locationId: '',
            evidenceLevel: 'ISOLATED',
            skipSecretScan: true,
          });
          expect(res.ok).toBe(true);
          expect(res.overallVerdict).toBe('PASS');
          expect(res.totals.pass).toBe(3);
          expect(res.totals.fail).toBe(0);
          const pm010 = readCaseById(res.evidenceDir, 'PM-010');
          const pm011 = readCaseById(res.evidenceDir, 'PM-011');
          const pm012 = readCaseById(res.evidenceDir, 'PM-012');
          expect(pm010.status).toBe('PASS');
          expect(pm010.httpStatus).toBe(200);
          expect(pm011.status).toBe('PASS');
          expect(pm011.httpStatus).toBe(200);
          expect(pm012.status).toBe('PASS');
          expect(pm012.httpStatus).toBe(200);
          expect(pm012.url).toContain(`skus=${SIMPLE_SKU}`);
        } finally {
          if (!keep) rmSync(outDir, { recursive: true, force: true });
        }
      }

      // Escenario 2: SKU multi-ubicación (MULTI_VAR_ELIGIBLE_SKU) sin location_id -> PM-010/011 PASS y PM-012 FAIL con HTTP 400 VALIDACION
      {
        const { outDir, keep } = allocateOutDir('g6-h27-inv-multi-noloc-');
        try {
          const res = await executeSuite({
            env: 'local',
            baseUrl: gatewayOrigin,
            folder: '02 - Preparacion comercial e Inventory',
            runId: 'h27-real-inv-multi-noloc',
            outDir,
            accessToken: token,
            productId: MULTI_PROD_ID,
            sku: MULTI_VAR_ELIGIBLE_SKU,
            locationId: '',
            evidenceLevel: 'ISOLATED',
            skipSecretScan: true,
          });
          expect(res.overallVerdict).toBe('FAIL');
          expect(res.totals.pass).toBe(2);
          expect(res.totals.fail).toBe(1);
          const pm010 = readCaseById(res.evidenceDir, 'PM-010');
          const pm011 = readCaseById(res.evidenceDir, 'PM-011');
          const pm012 = readCaseById(res.evidenceDir, 'PM-012');
          expect(pm010.status).toBe('PASS');
          expect(pm010.httpStatus).toBe(200);
          expect(pm011.status).toBe('PASS');
          expect(pm011.httpStatus).toBe(200);
          expect(pm012.status).toBe('FAIL');
          expect(pm012.httpStatus).toBe(400);
          expect(pm012.url).not.toContain('location_id=');
          const directResp = await fetch(
            `${gatewayOrigin}/api/v1/inventario/disponibilidad?skus=${encodeURIComponent(MULTI_VAR_ELIGIBLE_SKU)}`,
            { headers: { Authorization: `Bearer ${token}` } },
          );
          expect(directResp.status).toBe(400);
          const directBody = (await directResp.json()) as { code?: string };
          expect(directBody.code).toBe('VALIDACION');
        } finally {
          if (!keep) rmSync(outDir, { recursive: true, force: true });
        }
      }

      // Escenario 3: SKU multi-ubicación con fixture explícito location_id UUID (LOC_LIMA_ID) -> PM-010/011/012 HTTP 200 PASS + saldo esperado
      {
        const { outDir, keep } = allocateOutDir('g6-h27-inv-multi-valid-');
        try {
          const res = await executeSuite({
            env: 'local',
            baseUrl: gatewayOrigin,
            folder: '02 - Preparacion comercial e Inventory',
            runId: 'h27-real-inv-multi-valid-loc',
            outDir,
            accessToken: token,
            productId: MULTI_PROD_ID,
            sku: MULTI_VAR_ELIGIBLE_SKU,
            locationId: LOC_LIMA_ID,
            evidenceLevel: 'ISOLATED',
            skipSecretScan: true,
          });
          expect(res.ok).toBe(true);
          expect(res.overallVerdict).toBe('PASS');
          expect(res.totals.pass).toBe(3);
          expect(res.totals.fail).toBe(0);
          const pm010 = readCaseById(res.evidenceDir, 'PM-010');
          const pm011 = readCaseById(res.evidenceDir, 'PM-011');
          const pm012 = readCaseById(res.evidenceDir, 'PM-012');
          expect(pm010.status).toBe('PASS');
          expect(pm011.status).toBe('PASS');
          expect(pm012.status).toBe('PASS');
          expect(pm012.httpStatus).toBe(200);
          expect(pm012.url).toContain(`location_id=${LOC_LIMA_ID}`);
        } finally {
          if (!keep) rmSync(outDir, { recursive: true, force: true });
        }
      }

      // Escenario 4: Ubicación sin saldo (LOC_SIN_SALDO_ID) -> PM-010/011 PASS y PM-012 FAIL controlado con HTTP 200 items=[]
      {
        const { outDir, keep } = allocateOutDir('g6-h27-inv-empty-');
        try {
          const res = await executeSuite({
            env: 'local',
            baseUrl: gatewayOrigin,
            folder: '02 - Preparacion comercial e Inventory',
            runId: 'h27-real-inv-empty-loc',
            outDir,
            accessToken: token,
            productId: MULTI_PROD_ID,
            sku: MULTI_VAR_ELIGIBLE_SKU,
            locationId: LOC_SIN_SALDO_ID,
            evidenceLevel: 'ISOLATED',
            skipSecretScan: true,
          });
          expect(res.overallVerdict).toBe('FAIL');
          expect(res.totals.pass).toBe(2);
          expect(res.totals.fail).toBe(1);
          const pm010 = readCaseById(res.evidenceDir, 'PM-010');
          const pm011 = readCaseById(res.evidenceDir, 'PM-011');
          const pm012 = readCaseById(res.evidenceDir, 'PM-012');
          expect(pm010.status).toBe('PASS');
          expect(pm011.status).toBe('PASS');
          expect(pm012.status).toBe('FAIL');
          expect(pm012.httpStatus).toBe(200);
          expect(pm012.url).toContain(`location_id=${LOC_SIN_SALDO_ID}`);
          expect(
            pm012.assertions.some(
              (a) =>
                !a.passed && /empty|vacio|items/i.test(a.errorMessage || ''),
            ),
          ).toBe(true);
        } finally {
          if (!keep) rmSync(outDir, { recursive: true, force: true });
        }
      }
    }, 90000);

    it('H27 preflight y negativos reales (Carpetas 00 y 09): preserva readiness 503 como FAIL y valida 401/404/400 contra servicios reales', async () => {
      const { outDir, keep } = allocateOutDir('g6-h27-preflight-neg-');
      try {
        // Carpeta 00: PM-001 (/health) -> 200 PASS; PM-001B (/health/ready) -> 503 FAIL honesto
        const preflightRes = await executeSuite({
          env: 'local',
          baseUrl: gatewayOrigin,
          folder: '00 - Preflight y autenticacion',
          runId: 'h27-real-gateway-preflight',
          outDir,
          allowNoAuth: true,
          evidenceLevel: 'ISOLATED',
          skipSecretScan: true,
        });
        expect(preflightRes.totals.pass).toBe(1);
        expect(preflightRes.totals.fail).toBe(1);
        expect(preflightRes.overallVerdict).toBe('FAIL');
        expect(
          readCaseById(preflightRes.evidenceDir, 'PM-001').httpStatus,
        ).toBe(200);
        expect(
          readCaseById(preflightRes.evidenceDir, 'PM-001B').httpStatus,
        ).toBe(503);

        // Carpeta 09: PM-004, PM-004B, PM-006, PM-007A, PM-007B, PM-008 PASS; PM-005 NOT_RUN
        const negRes = await executeSuite({
          env: 'local',
          baseUrl: gatewayOrigin,
          folder: '09 - APIM, Gateway y G7',
          runId: 'h27-real-gateway-negatives',
          outDir,
          accessToken: userToken(),
          restrictedAccessToken: '',
          evidenceLevel: 'ISOLATED',
          skipSecretScan: true,
        });
        expect(negRes.totals.fail).toBe(0);
        expect(negRes.totals.pass).toBe(6);
        expect(negRes.totals.notRunPmCases).toBe(1);
        expect(negRes.overallVerdict).toBe('PARTIAL_NOT_COMPLETE');
        expect(negRes.exitCode).toBe(5);
        expect(readCaseById(negRes.evidenceDir, 'PM-005').status).toBe(
          'NOT_RUN',
        );
      } finally {
        if (!keep) rmSync(outDir, { recursive: true, force: true });
      }
    }, 60000);
  },
);
