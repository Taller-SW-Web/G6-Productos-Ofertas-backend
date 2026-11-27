import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PricingImports } from '../src/application/pricing-imports.js';
import {
  PRICING_CATALOG_CONTEXT,
  type PricingCatalogContext,
} from '../src/http/commercial-prices.js';
import { PricingHttpError } from '../src/http/pricing-http.error.js';
import { PricingServiceBusRuntime } from '../src/messaging/service-bus-relay.js';
import { PricingSvcModule } from '../src/pricing-svc.module.js';
import { IsolatedPostgres } from './isolated-postgres.js';
import { SignedUser } from './signed-user.js';

const base = '/api/v1/precios/importaciones';
const headers =
  'sku,channelId,priceVersion,precioRegular,accionPrecioOferta,precioOferta,moneda,motivoCambio\r\n';
const csv = (...rows: string[]) =>
  Buffer.from(headers + rows.join('\r\n') + '\r\n');
const row = (sku: string, version = 1) =>
  `${sku},,${version},19.99,CONSERVAR,,PEN,"Cierre, ""v1"""`;

describe.skipIf(process.env.PRICING_TEST_POSTGRES !== '1')(
  'Importación CSV v1 HTTP/PostgreSQL',
  () => {
    const postgres = new IsolatedPostgres();
    const identity = new SignedUser();
    let app: INestApplication;
    let imports: PricingImports;
    let deny = false;
    let catalogDown = false;
    let introspections = 0;
    const productId = randomUUID();
    const catalog: PricingCatalogContext = {
      batchMode: 'G7_AUTHENTICATED',
      resolve: async () => null,
      resolveBatch: async (skus) => {
        if (catalogDown)
          throw new PricingHttpError(503, 'SERVICIO_NO_DISPONIBLE');
        return skus.map((sku) => ({
          sku,
          productId,
          isVariant: true,
          active: true,
          eligible: true,
        }));
      },
    };
    const post = (
      path: string,
      data: Buffer,
      partial?: boolean | string,
      key = randomUUID(),
    ) => {
      const upload = request(app.getHttpServer())
        .post(path)
        .auth(identity.token(), { type: 'bearer' })
        .set('Idempotency-Key', key);
      if (partial !== undefined) upload.field('allow_partial', String(partial));
      return upload.attach('archivo', data, 'precios.csv');
    };
    const get = (path: string, token = identity.token()) =>
      request(app.getHttpServer()).get(path).auth(token, { type: 'bearer' });

    async function createApp(runWorker = false, pilot = false) {
      const module = await Test.createTestingModule({
        imports: [
          PricingSvcModule.forRoot({
            NODE_ENV: 'test',
            PORT: '3002',
            DATABASE_URL: postgres.runtimeUrl,
            AUTH_ISSUER: identity.issuer,
            AUTH_JWKS_URL: identity.issuer + '/jwks',
            PRICING_SERVICE_TOKEN_URL: identity.issuer + '/api/v1/auth/token',
            PRICING_SERVICE_CLIENT_SECRET: 'fixture-secret',
            PRICING_CATALOG_URL: identity.issuer,
            ...(pilot && {
              MESSAGING_PROVIDER: 'AZURE_SERVICE_BUS',
              G6_SERVICE_BUS_PILOT_ENABLED: 'true',
              PRICING_PRICE_CHANGED_PUBLISH_ENABLED: 'true',
              SERVICE_BUS_NAMESPACE_FQDN:
                'fixture-pricing.servicebus.windows.net',
            }),
          }),
        ],
      })
        .overrideProvider(PRICING_CATALOG_CONTEXT)
        .useValue(catalog)
        .overrideProvider(PricingServiceBusRuntime)
        .useValue({ available: true })
        .compile();
      const imports = module.get(PricingImports);
      if (!runWorker)
        vi.spyOn(imports, 'onApplicationBootstrap').mockImplementation(
          () => undefined,
        );
      const app = module.createNestApplication({ logger: false });
      await app.init();
      return { app, imports };
    }

    async function startApp(runWorker = false) {
      ({ app, imports } = await createApp(runWorker));
    }

    beforeAll(async () => {
      await postgres.start();
      await identity.start(true, () => {
        introspections++;
        return !deny;
      });
      await startApp();
    }, 90000);

    afterAll(async () => {
      await app?.close();
      await identity.stop();
      await postgres.stop();
    });

    async function seed(sku: string) {
      await postgres.admin!.query(
        `
      WITH p AS (INSERT INTO pricing.prices (sku) VALUES ($1) RETURNING id)
      INSERT INTO pricing.price_validities
        (price_id, precio_regular, currency, valid_from, price_version, motivo_cambio)
      SELECT id, 10, 'PEN', '2020-01-01Z', 1, 'fixture' FROM p
    `,
        [sku],
      );
    }
    async function version(sku: string) {
      const { rows } = await postgres.admin!.query<{ price_version: string }>(
        'SELECT price_version FROM pricing.prices WHERE sku=$1',
        [sku],
      );
      return rows[0].price_version;
    }

    it('prevalida sin escrituras y devuelve errores por fila o por archivo', async () => {
      await seed('preview');
      const preview = await post(
        base + '/prevalidar',
        csv(row('preview'), row('missing')),
      ).expect(200);
      expect(preview.body).toEqual({
        valid: false,
        total_rows: 2,
        errors: [
          {
            row_id: '3',
            status: 'FAILED',
            sku: 'missing',
            code: 'PRECIO_NO_ENCONTRADO',
          },
        ],
      });
      await post(base + '/prevalidar', Buffer.from('otra,cabecera\n')).expect(
        422,
      );
      await post(base + '/prevalidar', Buffer.from([0xff])).expect(400);
      await post(base + '/prevalidar', Buffer.alloc(1024 * 1024 + 1)).expect(
        413,
      );
      const oversized = csv(
        ...Array.from({ length: 1001 }, (_, i) => row(`sku-${i}`)),
      );
      await post(base + '/prevalidar', oversized).expect(413);
      const duplicate = await post(
        base + '/prevalidar',
        csv(row('preview'), row('preview')),
      ).expect(200);
      expect(duplicate.body.errors).toHaveLength(2);
      expect(await version('preview')).toBe('1');
      expect(
        (await postgres.admin!.query('SELECT 1 FROM pricing.bulk_price_jobs'))
          .rowCount,
      ).toBe(0);
    });

    it('deniega las cinco mutaciones con identidad revocada antes de tocar PostgreSQL', async () => {
      deny = true;
      const before = introspections;
      try {
        await post(base, csv(row('denied')), false).expect(401);
        for (const [method, suffix] of [
          ['patch', '/skus/denied'],
          ['patch', `/productos/${productId}`],
          ['post', '/skus/denied/programaciones'],
          ['post', `/productos/${productId}/programaciones`],
        ] as const) {
          await request(app.getHttpServer())
            [method]('/api/v1/precios' + suffix)
            .auth(identity.token(), { type: 'bearer' })
            .send({})
            .expect(401);
        }
        expect(introspections - before).toBe(5);
        expect(
          (await postgres.admin!.query('SELECT 1 FROM pricing.bulk_price_jobs'))
            .rowCount,
        ).toBe(0);
        expect(
          (await postgres.admin!.query('SELECT 1 FROM pricing.outbox'))
            .rowCount,
        ).toBe(0);
      } finally {
        deny = false;
      }
    });

    it('repite la admisión concurrente y recupera un lote sin duplicar cambios ni Outbox', async () => {
      await seed('recover');
      const key = randomUUID();
      const file = csv(row('recover'));
      const [first, duplicate] = await Promise.all([
        post(base, file, false, key).expect(202),
        post(base, file, false, key).expect(202),
      ]);
      expect(duplicate.body).toEqual(first.body);
      const id = first.body.batch_id;
      await post(base, file, true, key).expect(409);
      catalogDown = true;
      try {
        await post(base + '/prevalidar', file).expect(503);
        await expect(imports.processNext()).rejects.toMatchObject({
          code: 'SERVICIO_NO_DISPONIBLE',
        });
      } finally {
        catalogDown = false;
      }
      const queued = await get(`${base}/${id}`).expect(200);
      expect(queued.body.status).toBe('QUEUED');
      expect(await version('recover')).toBe('1');
      const second = await createApp();
      try {
        const processed = await Promise.all([
          imports.processNext(),
          second.imports.processNext(),
        ]);
        expect(processed.sort()).toEqual([false, true]);
      } finally {
        await second.app.close();
      }
      expect(await imports.processNext()).toBe(false);
      expect(await version('recover')).toBe('2');
      const facts = await postgres.admin!.query(
        "SELECT payload FROM pricing.outbox WHERE payload->>'batch_id'=$1",
        [id],
      );
      expect(facts.rows).toEqual([
        {
          payload: expect.objectContaining({
            sku: 'recover',
            new_price: '19.99',
            channel_id: null,
          }),
        },
      ]);
      const report = await get(`${base}/${id}/reporte`).expect(200);
      expect(report.text).toContain('"recover","COMPLETED"');
    });

    it('revierte una fila ya aplicada si falla la siguiente, o conserva solo la válida en modo parcial', async () => {
      await seed('a-valid');
      await seed('z-stale');
      const data = csv(row('a-valid'), row('z-stale', 99));
      for (const allowPartial of [false, true]) {
        const {
          body: { batch_id: id },
        } = await post(base, data, allowPartial).expect(202);
        await imports.processNext();
        const { body } = await get(`${base}/${id}`).expect(200);
        expect(body).toMatchObject({
          status: allowPartial ? 'PARTIAL' : 'FAILED',
          completed_rows: allowPartial ? 1 : 0,
          rows: expect.arrayContaining([
            expect.objectContaining({
              sku: 'z-stale',
              code: 'VERSION_CONFLICT',
            }),
          ]),
        });
        expect(await version('a-valid')).toBe(allowPartial ? '2' : '1');
        const facts = await postgres.admin!.query(
          "SELECT 1 FROM pricing.outbox WHERE payload->>'batch_id'=$1",
          [id],
        );
        expect(facts.rowCount).toBe(allowPartial ? 1 : 0);
      }
    });

    it('valida multipart, aísla las lecturas y conserva el orden y escape CSV', async () => {
      const file = csv(
        ...Array.from({ length: 10 }, (_, i) => row(`new-${i}`)),
        row('"A,""B"""'),
        row('=formula'),
      );
      await post(base + '/prevalidar', file, false).expect(400);
      await post(base, file, 'yes').expect(400);
      await post(base, file, undefined, '').expect(400);
      const admitted = await post(base, file).expect(202);
      expect(admitted.body.allow_partial).toBe(false);
      const path = `${base}/${admitted.body.batch_id}`;
      const other = identity.token({ sub: randomUUID() });
      for (const suffix of ['', '/reporte']) {
        await request(app.getHttpServer())
          .get(path + suffix)
          .expect(401);
        await get(path + suffix, identity.token({ roles: [] })).expect(403);
        const correlation = randomUUID();
        const foreign = await get(path + suffix, other)
          .set('X-Correlation-Id', correlation)
          .expect(404);
        const missing = await get(`${base}/${randomUUID()}${suffix}`, other)
          .set('X-Correlation-Id', correlation)
          .expect(404);
        expect(foreign.body).toEqual(missing.body);
      }
      await get(path).expect(200);
      const report = await get(path + '/reporte').expect(200);
      expect(report.headers['content-type']).toMatch(/^text\/csv/);
      expect(report.text.split('\r\n')).toEqual([
        'row_id,sku,status,code',
        ...Array.from(
          { length: 10 },
          (_, i) => `"${i + 2}","new-${i}","PENDING",""`,
        ),
        '"12","A,""B""","PENDING",""',
        `"13","'=formula","PENDING",""`,
        '',
      ]);
      await imports.processNext();
    });

    it('revierte el cambio y el hecho ante un fallo de entrega piloto y reintenta una sola vez', async () => {
      const admin = postgres.admin!;
      const migration = await readFile(
        new URL(
          '../migrations-candidate/h5/0001_outbox_delivery.sql',
          import.meta.url,
        ),
        'utf8',
      );
      const r2RoutesMigration = await readFile(
        new URL(
          '../migrations/0003_service_bus_h5_routes_r2.sql',
          import.meta.url,
        ),
        'utf8',
      );
      await admin.query(
        `BEGIN; SET LOCAL ROLE po_pricing_owner; ${migration}\n${r2RoutesMigration} COMMIT;`,
      );
      const pilot = await createApp(false, true);
      try {
        await seed('pilot-update');
        const file = csv(row('pilot-update'));
        const key = randomUUID();
        const { body } = await post(base, file, false, key).expect(202);
        const id = body.batch_id;
        const facts = () =>
          admin.query(
            `SELECT d.destination, d.sent_at FROM pricing.outbox o
           LEFT JOIN pricing.outbox_delivery d USING (message_id)
           WHERE o.payload->>'batch_id'=$1`,
            [id],
          );
        await admin.query(
          'ALTER TABLE pricing.outbox_delivery ADD CONSTRAINT fixture_rollback CHECK (false)',
        );
        try {
          await expect(pilot.imports.processNext()).rejects.toMatchObject({
            sqlState: '23514',
          });
          expect((await facts()).rows).toEqual([]);
          expect(await version('pilot-update')).toBe('1');
          expect((await get(`${base}/${id}`).expect(200)).body.status).toBe(
            'QUEUED',
          );
        } finally {
          await admin.query(
            'ALTER TABLE pricing.outbox_delivery DROP CONSTRAINT fixture_rollback',
          );
        }
        expect((await post(base, file, false, key).expect(202)).body).toEqual(
          body,
        );
        expect(await pilot.imports.processNext()).toBe(true);
        expect(await pilot.imports.processNext()).toBe(false);
        expect(await version('pilot-update')).toBe('2');
        expect((await facts()).rows).toEqual([
          { destination: 'g6.price-audit.from.pricing', sent_at: null },
        ]);
        const correlation = randomUUID();
        await request(pilot.app.getHttpServer())
          .patch(`/api/v1/precios/productos/${randomUUID()}`)
          .auth(identity.token(), { type: 'bearer' })
          .set('X-Correlation-Id', correlation)
          .send({
            priceVersion: 0,
            precioRegular: 20,
            accionPrecioOferta: 'CONSERVAR',
            moneda: 'PEN',
            motivoCambio: 'Creaci�n en piloto',
          })
          .expect(200);
        const created = await admin.query(
          `SELECT d.destination FROM pricing.outbox o
           JOIN pricing.outbox_delivery d USING (message_id)
           WHERE o.correlation_id=$1`,
          [correlation],
        );
        expect(created.rows).toEqual([
          { destination: 'g6.price-audit.from.pricing' },
        ]);
      } finally {
        await pilot.app.close();
      }
    });

    it('reanuda un lote admitido al arrancar una nueva instancia de Pricing', async () => {
      await seed('restart');
      const {
        body: { batch_id },
      } = await post(base, csv(row('restart')), false).expect(202);
      await app.close();
      await startApp(true);
      await vi.waitFor(
        async () => {
          expect(
            (await get(`${base}/${batch_id}`).expect(200)).body.status,
          ).toBe('COMPLETED');
        },
        { timeout: 5000 },
      );
      expect(await version('restart')).toBe('2');
    });

    it('mantiene readiness y lecturas de precios con Catalog configurado antes de la migración de importación', async () => {
      await app.close();
      await postgres.admin!.query(`
        ALTER TABLE pricing.bulk_price_jobs
          DROP COLUMN idempotency_key, DROP COLUMN request_hash
      `);
      await postgres.admin!.query(
        `
        WITH p AS (INSERT INTO pricing.prices (product_id) VALUES ($1) RETURNING id)
        INSERT INTO pricing.price_validities
          (price_id, precio_regular, currency, valid_from, price_version, motivo_cambio)
        SELECT id, 10, 'PEN', '2020-01-01Z', 1, 'fixture' FROM p
      `,
        [productId],
      );
      await startApp();
      await request(app.getHttpServer()).get('/health/ready').expect(200);
      await get(`/api/v1/precios/productos/${productId}`).expect(200);
      expect(await imports.processNext()).toBe(false);
      await post(base, csv(row('preview')), false).expect(503);
    });
  },
);
