import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { CombosSvcModule } from '../src/combos-svc.module.js';
import { CombosProblemFilter } from '../src/http/combos-problem.filter.js';
import { combosCorrelationMiddleware } from '../src/http/combos-correlation.middleware.js';

const isolatedPerformanceEnabled =
  process.env.COMBOS_TEST_EPHEMERAL === '1' &&
  process.env.COMBOS_TEST_DATABASE_URL === 'harness-owned' &&
  process.env.G6_PERFORMANCE_HTTP === '1';

function percentile(values: number[], ratio: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)] ?? 0;
}

function csvCell(value: unknown): string {
  return `"${String(value ?? '').replaceAll('"', '""')}"`;
}

describe.skipIf(!isolatedPerformanceEnabled)(
  'Combos H5 HTTP performance benchmark (PostgreSQL 17 TLS, no RabbitMQ)',
  () => {
    let app: INestApplication;
    let baseUrl: string;
    let catalog: Server;
    let pricing: Server;
    let identity: Server;
    let issuer = '';
    const keyPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const kid = 'combos-h5-perf-key';
    const backup: Record<string, string | undefined> = {};
    const keys = [
      'PGHOST',
      'PGSSLMODE',
      'PGSSLROOTCERT',
      'COMBOS_AMQP_ENABLED',
      'COMBOS_RESTRICTED_DEMO_ENABLED',
      'G6_SECURITY_MODE',
      'COMBOS_CATALOG_URL',
      'COMBOS_PRICING_URL',
      'COMBOS_CATALOG_CONTEXT_AUTHORIZED',
      'COMBOS_CATALOG_SERVICE_BEARER',
      'COMBOS_PRICING_SERVICE_BEARER',
      'COMBOS_G7_TOKEN_URL',
      'COMBOS_G7_CLIENT_SECRET',
      'COMBOS_ALLOWED_ROLES_LISTAR_COMBOS_ADMIN',
      'COMBOS_ALLOWED_ROLES_CREAR_COMBO',
      'COMBOS_ALLOWED_ROLES_CREAR_COMBO_ADMINISTRACION',
      'COMBOS_ALLOWED_ROLES_OBTENER_COMBO',
      'COMBOS_ALLOWED_ROLES_ACTUALIZAR_COMBO',
      'COMBOS_ALLOWED_ROLES_DESACTIVAR_COMBO',
      'COMBOS_ALLOWED_ROLES_CONSULTAR_DISPONIBILIDAD_COMBO',
      'SECURITY_ISSUER',
      'SECURITY_DISCOVERY_URL',
      'SECURITY_JWKS_URL',
    ];

    const encode = (value: unknown) =>
      Buffer.from(JSON.stringify(value)).toString('base64url');

    const makeHumanToken = (sub: string) => {
      const now = Math.floor(Date.now() / 1000);
      const claims = {
        iss: issuer,
        sub,
        tipo: 'acceso',
        aud: ['api-productos'],
        roles: ['GESTOR_COMERCIAL'],
        iat: now,
        exp: now + 1800,
        jti: randomUUID(),
      };
      const unsigned = `${encode({ alg: 'RS256', kid })}.${encode(claims)}`;
      return `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), keyPair.privateKey).toString('base64url')}`;
    };

    beforeAll(async () => {
      for (const key of keys) backup[key] = process.env[key];
      for (const key of keys.filter((name) =>
        name.startsWith('COMBOS_ALLOWED_ROLES_'),
      )) {
        process.env[key] = 'GESTOR_COMERCIAL';
      }
      process.env.PGHOST = '127.0.0.1';
      process.env.PGSSLMODE = 'verify-full';
      process.env.PGSSLROOTCERT = process.env.COMBOS_TEST_CA!;
      process.env.COMBOS_AMQP_ENABLED = 'false';
      process.env.G6_SECURITY_MODE = 'G7_AUTHENTICATED';
      process.env.COMBOS_RESTRICTED_DEMO_ENABLED = 'false';
      process.env.COMBOS_CATALOG_CONTEXT_AUTHORIZED = 'true';
      process.env.COMBOS_CATALOG_SERVICE_BEARER = 'isolated-perf-service-token';
      process.env.COMBOS_PRICING_SERVICE_BEARER = 'isolated-perf-service-token';

      identity = createServer((req, res) => {
        res.setHeader('content-type', 'application/json');
        res.setHeader('cache-control', 'public, max-age=60');
        if (req.url === '/.well-known/openid-configuration') {
          res.end(JSON.stringify({ issuer, jwks_uri: `${issuer}/jwks` }));
          return;
        }
        if (req.url === '/jwks') {
          res.end(
            JSON.stringify({
              keys: [
                {
                  ...keyPair.publicKey.export({ format: 'jwk' }),
                  kid,
                  alg: 'RS256',
                  use: 'sig',
                },
              ],
            }),
          );
          return;
        }
        res.writeHead(404).end('{}');
      });
      identity.listen(0, '127.0.0.1');
      await once(identity, 'listening');
      issuer = `http://127.0.0.1:${(identity.address() as AddressInfo).port}`;
      process.env.SECURITY_ISSUER = issuer;
      process.env.SECURITY_DISCOVERY_URL = `${issuer}/.well-known/openid-configuration`;
      process.env.SECURITY_JWKS_URL = `${issuer}/jwks`;

      catalog = createServer((req, res) => {
        const sku = decodeURIComponent((req.url ?? '').split('/').at(-2) ?? '');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            sku,
            productId: '00000000-0000-4000-8000-000000000020',
            isVariant: false,
            active: true,
            eligible: true,
          }),
        );
      });
      pricing = createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const skus = url.pathname.includes('/skus/')
          ? [decodeURIComponent(url.pathname.split('/').at(-1)!)]
          : (url.searchParams.get('skus') ?? '').split(',');
        const item = (sku: string) => ({
          sku,
          precio_regular: 15.0,
          precio_oferta: 12.0,
          currency: 'PEN',
          channel_id: null,
          valid_from: '2026-01-01T00:00:00Z',
          valid_until: null,
          price_version: 1,
          vigencia_id: `validity-${sku}`,
          origen: 'PRODUCTO',
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          url.pathname.includes('/skus/')
            ? JSON.stringify(item(skus[0]!))
            : JSON.stringify({ items: skus.map(item) }),
        );
      });

      catalog.listen(0, '127.0.0.1');
      pricing.listen(0, '127.0.0.1');
      await Promise.all([
        once(catalog, 'listening'),
        once(pricing, 'listening'),
      ]);
      process.env.COMBOS_CATALOG_URL = `http://127.0.0.1:${(catalog.address() as AddressInfo).port}`;
      process.env.COMBOS_PRICING_URL = `http://127.0.0.1:${(pricing.address() as AddressInfo).port}`;

      const module = await Test.createTestingModule({
        imports: [CombosSvcModule],
      }).compile();
      app = module.createNestApplication();
      app.setGlobalPrefix('api/v1', { exclude: ['health', 'ready'] });
      app.use(combosCorrelationMiddleware);
      app.useGlobalFilters(new CombosProblemFilter());
      await app.init();
      await app.listen(0, '127.0.0.1');
      baseUrl = await app.getUrl();
    }, 30000);

    afterAll(async () => {
      await app?.close();
      await Promise.all([
        new Promise((done) => catalog?.close(done) ?? done(undefined)),
        new Promise((done) => pricing?.close(done) ?? done(undefined)),
        new Promise((done) => identity?.close(done) ?? done(undefined)),
      ]);
      for (const key of keys) {
        if (backup[key] === undefined) delete process.env[key];
        else process.env[key] = backup[key];
      }
    });

    it('mide CRUD administrativo, paginado, PATCH con versión y recuperación idempotente sin RabbitMQ', async () => {
      const actorSub = randomUUID();
      const bearer = makeHumanToken(actorSub);
      const rawSamples = process.env.G6_PERFORMANCE_SAMPLES ?? '40';
      if (!/^[1-9]\d*$/.test(rawSamples)) {
        throw new Error(
          `G6_PERFORMANCE_SAMPLES inválido (${rawSamples}); debe ser entero positivo entre 1 y 1000.`,
        );
      }
      const samplesPerLevel = Number(rawSamples);
      if (
        !Number.isSafeInteger(samplesPerLevel) ||
        samplesPerLevel < 1 ||
        samplesPerLevel > 1000
      ) {
        throw new Error(
          `G6_PERFORMANCE_SAMPLES fuera de rango (${rawSamples}); máximo permitido: 1000.`,
        );
      }
      const warmupRequests = 5;
      const concurrencies = [1, 8] as const;
      const outputDir = resolve(
        process.env.G6_PERFORMANCE_OUTPUT ?? '.ci/performance',
      );
      const variant = process.env.G6_PERFORMANCE_VARIANT ?? 'candidate';
      const sha = process.env.G6_PERFORMANCE_SHA ?? 'local';
      const baselineSha = process.env.G6_PERFORMANCE_BASELINE_SHA ?? null;
      const pairId = process.env.G6_PERFORMANCE_PAIR_ID ?? null;

      const createdCombos: Array<{
        comboId: string;
        version: number;
        idempotencyKey: string;
        payload: Record<string, unknown>;
      }> = [];

      const isUsableComboDto = (
        value: unknown,
      ): value is { combo_id: string; version: number } => {
        if (!value || typeof value !== 'object') return false;
        const candidate = value as Record<string, unknown>;
        return (
          typeof candidate.combo_id === 'string' &&
          candidate.combo_id.trim().length > 0 &&
          typeof candidate.version === 'number' &&
          Number.isInteger(candidate.version) &&
          candidate.version >= 0
        );
      };

      const createPayload = (label: string) => ({
        nombre: `Combo H5 Perf ${label}`,
        descripcion: 'Escenario benchmark PostgreSQL sin RabbitMQ',
        componentes: [
          { sku: 'PERF-SKU-001', cantidad: 1 },
          { sku: 'PERF-SKU-002', cantidad: 2 },
        ],
        precioCombo: 25.5,
      });

      const runMeasured = async (
        operation: string,
        method: string,
        pathTemplate: string,
        expectedStatus: number,
        concurrency: number,
        samples: number,
        execute: (index: number) => Promise<{
          res: Response;
          valid?: boolean;
        }>,
      ) => {
        if (!Number.isSafeInteger(samples) || samples < 1) {
          throw new Error(
            `Cantidad de muestras inválida para ${operation}: ${samples}`,
          );
        }
        const latencies: number[] = [];
        let errors = 0;
        const started = performance.now();
        for (let offset = 0; offset < samples; offset += concurrency) {
          const batchSize = Math.min(concurrency, samples - offset);
          await Promise.all(
            Array.from({ length: batchSize }, async (_, slot) => {
              const reqStart = performance.now();
              try {
                const { res, valid = true } = await execute(offset + slot);
                if (res.status !== expectedStatus || !valid) {
                  errors += 1;
                  return;
                }
                latencies.push(performance.now() - reqStart);
              } catch {
                errors += 1;
              }
            }),
          );
        }
        const elapsedMs = performance.now() - started;
        if (
          latencies.length === 0 ||
          !Number.isFinite(elapsedMs) ||
          elapsedMs <= 0
        ) {
          throw new Error(
            `Sin muestras válidas para ${operation} (errors=${errors}, samples=${samples})`,
          );
        }
        const row = {
          operation,
          method,
          path: pathTemplate,
          expectedStatus,
          concurrency,
          samples,
          successfulSamples: latencies.length,
          errors,
          p50_ms: Number(percentile(latencies, 0.5).toFixed(3)),
          p95_ms: Number(percentile(latencies, 0.95).toFixed(3)),
          p99_ms: Number(percentile(latencies, 0.99).toFixed(3)),
          min_ms: Number(Math.min(...latencies).toFixed(3)),
          max_ms: Number(Math.max(...latencies).toFixed(3)),
          throughput_rps: Number(
            ((latencies.length * 1000) / elapsedMs).toFixed(2),
          ),
        };
        for (const metric of [
          row.p50_ms,
          row.p95_ms,
          row.p99_ms,
          row.min_ms,
          row.max_ms,
          row.throughput_rps,
        ]) {
          if (!Number.isFinite(metric)) {
            throw new Error(`Métrica no finita en ${operation}`);
          }
        }
        return row;
      };

      for (let w = 0; w < warmupRequests; w += 1) {
        const key = randomUUID();
        const payload = createPayload(`warmup-${w}-${key}`);
        const res = await fetch(`${baseUrl}/api/v1/combos/administracion`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${bearer}`,
            'content-type': 'application/json',
            'idempotency-key': key,
          },
          body: JSON.stringify(payload),
        });
        expect(res.status).toBe(201);
        const created: unknown = await res.json();
        expect(isUsableComboDto(created)).toBe(true);
        if (!isUsableComboDto(created)) {
          throw new Error('DTO de creación inválido en warmup');
        }
        createdCombos.push({
          comboId: created.combo_id,
          version: created.version,
          idempotencyKey: key,
          payload,
        });
      }

      const rows: Array<Record<string, number | string>> = [];

      for (const concurrency of concurrencies) {
        rows.push(
          await runMeasured(
            'crear_combo_administracion',
            'POST',
            '/api/v1/combos/administracion',
            201,
            concurrency,
            samplesPerLevel,
            async () => {
              const key = randomUUID();
              const payload = createPayload(`c${concurrency}-${key}`);
              const res = await fetch(
                `${baseUrl}/api/v1/combos/administracion`,
                {
                  method: 'POST',
                  headers: {
                    authorization: `Bearer ${bearer}`,
                    'content-type': 'application/json',
                    'idempotency-key': key,
                  },
                  body: JSON.stringify(payload),
                },
              );
              const rawBody = await res.text();
              if (res.status !== 201) return { res, valid: false };
              let parsed: unknown;
              try {
                parsed = JSON.parse(rawBody);
              } catch {
                return { res, valid: false };
              }
              if (!isUsableComboDto(parsed)) return { res, valid: false };
              createdCombos.push({
                comboId: parsed.combo_id,
                version: parsed.version,
                idempotencyKey: key,
                payload,
              });
              return { res, valid: true };
            },
          ),
        );

        rows.push(
          await runMeasured(
            'obtener_combo_detalle',
            'GET',
            '/api/v1/combos/{comboId}',
            200,
            concurrency,
            samplesPerLevel,
            async (index) => {
              const target = createdCombos[index % createdCombos.length]!;
              const res = await fetch(
                `${baseUrl}/api/v1/combos/${target.comboId}`,
                {
                  headers: { authorization: `Bearer ${bearer}` },
                },
              );
              await res.arrayBuffer();
              return { res };
            },
          ),
        );

        rows.push(
          await runMeasured(
            'listar_combos_paginado',
            'GET',
            '/api/v1/combos?pagina=1&tamanio=20',
            200,
            concurrency,
            samplesPerLevel,
            async () => {
              const res = await fetch(
                `${baseUrl}/api/v1/combos?pagina=1&tamanio=20`,
                {
                  headers: { authorization: `Bearer ${bearer}` },
                },
              );
              await res.arrayBuffer();
              return { res };
            },
          ),
        );

        const patchPool = createdCombos.splice(0, samplesPerLevel);
        rows.push(
          await runMeasured(
            'actualizar_combo_patch_version',
            'PATCH',
            '/api/v1/combos/{comboId}',
            200,
            concurrency,
            patchPool.length,
            async (index) => {
              const target = patchPool[index]!;
              const res = await fetch(
                `${baseUrl}/api/v1/combos/${target.comboId}`,
                {
                  method: 'PATCH',
                  headers: {
                    authorization: `Bearer ${bearer}`,
                    'content-type': 'application/json',
                  },
                  body: JSON.stringify({
                    descripcion: `Actualizado v${target.version} c${concurrency}`,
                    version: target.version,
                  }),
                },
              );
              await res.arrayBuffer();
              return { res };
            },
          ),
        );

        rows.push(
          await runMeasured(
            'recuperacion_idempotente_receipt',
            'POST',
            '/api/v1/combos/administracion',
            201,
            concurrency,
            samplesPerLevel,
            async (index) => {
              const target = createdCombos[index % createdCombos.length]!;
              const res = await fetch(
                `${baseUrl}/api/v1/combos/administracion`,
                {
                  method: 'POST',
                  headers: {
                    authorization: `Bearer ${bearer}`,
                    'content-type': 'application/json',
                    'idempotency-key': target.idempotencyKey,
                  },
                  body: JSON.stringify(target.payload),
                },
              );
              const rawBody = await res.text();
              if (res.status !== 201) return { res, valid: false };
              let parsed: unknown;
              try {
                parsed = JSON.parse(rawBody);
              } catch {
                return { res, valid: false };
              }
              return {
                res,
                valid:
                  isUsableComboDto(parsed) &&
                  parsed.combo_id === target.comboId,
              };
            },
          ),
        );
      }

      const report = {
        classification: 'SIN_UMBRAL_APROBADO',
        scenario: 'combos-h5-postgres-only-http',
        sha,
        baselineSha,
        variant,
        pairId,
        rabbitmqStarted: false,
        azureServiceBusEnabled: false,
        postgresImage: 'postgres:17-alpine',
        tlsEnabled: true,
        providers:
          'local-http-fixtures (Catalog/Pricing/Identity, non-production)',
        limitation:
          'Proveedores HTTP locales simulados; no mide latencia de red real hacia Catalog, Pricing, G7 ni Azure Service Bus.',
        config: {
          samplesPerLevel,
          warmupRequests,
          concurrencies,
        },
        operations: rows,
      };

      await mkdir(outputDir, { recursive: true });
      await writeFile(
        resolve(outputDir, 'combos-h5-http-profile.json'),
        `${JSON.stringify(report, null, 2)}\n`,
      );
      const headers = [
        'classification',
        'sha',
        'variant',
        'operation',
        'method',
        'path',
        'concurrency',
        'samples',
        'errors',
        'p50_ms',
        'p95_ms',
        'p99_ms',
        'min_ms',
        'max_ms',
        'throughput_rps',
      ];
      const csvLines = [
        headers.join(','),
        ...rows.map((row) =>
          [
            report.classification,
            sha,
            variant,
            row.operation,
            row.method,
            row.path,
            row.concurrency,
            row.samples,
            row.errors,
            row.p50_ms,
            row.p95_ms,
            row.p99_ms,
            row.min_ms,
            row.max_ms,
            row.throughput_rps,
          ]
            .map(csvCell)
            .join(','),
        ),
      ];
      await writeFile(
        resolve(outputDir, 'combos-h5-http-profile.csv'),
        `${csvLines.join('\n')}\n`,
      );

      for (const row of rows) {
        expect(row.errors).toBe(0);
      }
    }, 120000);
  },
);
