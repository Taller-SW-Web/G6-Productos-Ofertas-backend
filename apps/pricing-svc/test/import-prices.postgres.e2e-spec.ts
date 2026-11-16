import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PricingImports } from '../src/application/pricing-imports.js';
import {
  PRICING_CATALOG_CONTEXT,
  type PricingCatalogContext,
} from '../src/http/commercial-prices.js';
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
        if (catalogDown) throw new Error('Fixture no disponible');
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
      partial: boolean,
      key = randomUUID(),
    ) =>
      request(app.getHttpServer())
        .post(path)
        .auth(identity.token(), { type: 'bearer' })
        .set('Idempotency-Key', key)
        .field('allow_partial', String(partial))
        .attach('archivo', data, 'precios.csv');
    const get = (path: string) =>
      request(app.getHttpServer())
        .get(path)
        .auth(identity.token(), { type: 'bearer' });

    async function startApp(runWorker = false) {
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
          }),
        ],
      })
        .overrideProvider(PRICING_CATALOG_CONTEXT)
        .useValue(catalog)
        .compile();
      imports = module.get(PricingImports);
      if (!runWorker)
        vi.spyOn(imports, 'onApplicationBootstrap').mockImplementation(
          () => undefined,
        );
      app = module.createNestApplication({ logger: false });
      await app.init();
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
        false,
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
      await post(
        base + '/prevalidar',
        Buffer.from('otra,cabecera\n'),
        false,
      ).expect(422);
      await post(base + '/prevalidar', Buffer.from([0xff]), false).expect(400);
      await post(
        base + '/prevalidar',
        Buffer.alloc(1024 * 1024 + 1),
        false,
      ).expect(413);
      const oversized = csv(
        ...Array.from({ length: 1001 }, (_, i) => row(`sku-${i}`)),
      );
      await post(base + '/prevalidar', oversized, false).expect(413);
      const duplicate = await post(
        base + '/prevalidar',
        csv(row('preview'), row('preview')),
        true,
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
      await expect(imports.processNext()).rejects.toThrow();
      catalogDown = false;
      const queued = await get(`${base}/${id}`).expect(200);
      expect(queued.body.status).toBe('QUEUED');
      expect(await version('recover')).toBe('1');
      expect(await imports.processNext()).toBe(true);
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

    it('reanuda un lote admitido al arrancar una nueva instancia de Pricing', async () => {
      await seed('restart');
      const {
        body: { batch_id },
      } = await post(base, csv(row('restart')), false).expect(202);
      await app.close();
      await startApp(true);
      await vi.waitFor(async () => {
        expect((await get(`${base}/${batch_id}`).expect(200)).body.status).toBe(
          'COMPLETED',
        );
      });
      expect(await version('restart')).toBe('2');
    });
  },
);
