import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { PricingSvcModule } from '../src/pricing-svc.module.js';
import {
  PricingDatabase,
  type PricingTransaction,
} from '../src/persistence/pricing.database.js';
import { PricingRepository } from '../src/persistence/pricing.repository.js';
import { PricingPersistenceError } from '../src/persistence/persistence.error.js';
import {
  prices,
  priceValidities,
  scheduledPrices,
  bulkPriceJobs,
  bulkPriceRows,
  outbox,
  inbox,
  pricingSchema,
} from '../src/persistence/pricing.schema.js';
import { IsolatedPostgres } from './isolated-postgres.js';
import { SignedUser } from './signed-user.js';
import { PricingMutations } from '../src/application/pricing-mutations.js';
import {
  changePrice,
  initializeProduct,
  schedulePrice,
  type PriceDefinition,
} from '../src/domain/price.js';

describe.skipIf(process.env.PRICING_TEST_POSTGRES !== '1')(
  'Pricing Drizzle / PostgreSQL aislado (#53)',
  () => {
    const postgres = new IsolatedPostgres();
    const identity = new SignedUser();
    let app: INestApplication<App> | undefined;
    let repository: PricingRepository;
    let database: PricingDatabase;
    let mutations: PricingMutations;
    const from = new Date('2030-01-01T00:00:00Z');
    const boundary = new Date('2031-01-01T00:00:00Z');
    const snapshot = (priceId: string, version = 1n) => ({
      priceId,
      precioRegular: '99.99',
      precioOferta: '80.25',
      currency: 'PEN',
      validFrom: from,
      priceVersion: version,
      motivoCambio: 'fixture',
      usuarioId: 'fixture-actor',
    });
    const event = () => ({
      messageId: randomUUID(),
      eventName: 'pricing.price.changed',
      kind: 'event',
      correlationId: randomUUID(),
      occurredAt: from,
      payload: {},
    });

    async function create(
      tx: PricingTransaction,
      target = { productId: randomUUID() },
      channelId: string | null = null,
    ) {
      const [definition] = await tx
        .insert(prices)
        .values({ ...target, channelId })
        .returning();
      const [validity] = await tx
        .insert(priceValidities)
        .values(snapshot(definition.id))
        .returning();
      return { definition, validity };
    }

    beforeAll(async () => {
      await postgres.start();
      await identity.start();
      const version = await postgres.admin!.query<{ server_version: string }>(
        'SHOW server_version',
      );
      console.info(
        `PostgreSQL aislado ${version.rows[0].server_version}; runtime pricing_app; SQL normativo c36bd9a.`,
      );
      const module = await Test.createTestingModule({
        imports: [
          PricingSvcModule.forRoot({
            NODE_ENV: 'test',
            PRICING_SVC_PORT: '3002',
            DATABASE_URL: postgres.runtimeUrl,
            PGSSLMODE: 'disable',
            AUTH_ISSUER: identity.issuer,
            AUTH_JWKS_URL: identity.issuer + '/jwks',
          }),
        ],
      }).compile();
      database = module.get(PricingDatabase);
      repository = module.get(PricingRepository);
      mutations = module.get(PricingMutations);
      app = module.createNestApplication();
      await app.init();
    }, 90000);

    afterAll(async () => {
      try {
        await app?.close();
      } finally {
        try {
          await identity.stop();
        } finally {
          await postgres.stop();
        }
      }
    }, 30000);

    it('HTTP devuelve precio base vigente real, contrato y correlación; no expone actor ni historial', async () => {
      const productId = randomUUID();
      const started = new Date(Date.now() - 60000);
      await repository.transaction(async (tx) => {
        const [price] = await tx
          .insert(prices)
          .values({ productId })
          .returning();
        await tx
          .insert(priceValidities)
          .values({ ...snapshot(price.id), validFrom: started });
      });
      const correlation = randomUUID();
      const response = await request(app!.getHttpServer())
        .get(`/api/v1/precios/productos/${productId}`)
        .set('Authorization', `Bearer ${identity.token()}`)
        .set('X-Correlation-Id', correlation)
        .expect(200);
      expect(response.headers['x-correlation-id']).toBe(correlation);
      expect(response.body).toEqual({
        product_id: productId,
        precio_regular: 99.99,
        precio_oferta: 80.25,
        currency: 'PEN',
        channel_id: null,
        valid_from: started.toISOString(),
        valid_until: null,
        price_version: 1,
      });
      expect(response.text).not.toContain('fixture-actor');
      const unknown = await request(app!.getHttpServer())
        .get(`/api/v1/precios/productos/${randomUUID()}`)
        .set('Authorization', `Bearer ${identity.token()}`)
        .expect(404);
      expect(unknown.headers['content-type']).toContain(
        'application/problem+json',
      );
      expect(unknown.body).toMatchObject({
        status: 404,
        code: 'PRECIO_NO_ENCONTRADO',
      });
    });

    it('HTTP pagina programaciones propias por producto/SKU y deriva estados sin escribir', async () => {
      const productId = randomUUID();
      const sku = `0000-${randomUUID()}`;
      const now = Date.now();
      const future = new Date(now + 3600000);
      await repository.transaction(async (tx) => {
        for (const target of [{ productId }, { sku }]) {
          const [price] = await tx
            .insert(prices)
            .values({ ...target, priceVersion: 2n })
            .returning();
          const [past] = await tx
            .insert(priceValidities)
            .values({
              ...snapshot(price.id),
              validFrom: new Date(now - 3600000),
              validUntil: future,
            })
            .returning();
          const [later] = await tx
            .insert(priceValidities)
            .values({ ...snapshot(price.id, 2n), validFrom: future })
            .returning();
          await tx.insert(scheduledPrices).values([
            {
              priceId: price.id,
              validityId: past.id,
              tipoPrecio: 'REGULAR',
              importe: '99.99',
            },
            {
              priceId: price.id,
              validityId: later.id,
              tipoPrecio: 'REGULAR',
              importe: '99.99',
            },
          ]);
        }
      });
      for (const path of [`productos/${productId}`, `skus/${sku}`]) {
        const response = await request(app!.getHttpServer())
          .get(`/api/v1/precios/${path}/programaciones?pagina=1&tamanio=1`)
          .set('Authorization', `Bearer ${identity.token()}`)
          .expect(200);
        expect(response.body.meta).toEqual({
          pagina: 1,
          tamanio: 1,
          total: 2,
          totalPaginas: 2,
        });
        expect(response.body.items[0]).toMatchObject({
          estado: 'ACTIVE',
          importe: 99.99,
          moneda: 'PEN',
          priceVersion: 1,
        });
        const next = await request(app!.getHttpServer())
          .get(`/api/v1/precios/${path}/programaciones?pagina=2&tamanio=1`)
          .set('Authorization', `Bearer ${identity.token()}`)
          .expect(200);
        expect(next.body.items[0]).toMatchObject({
          estado: 'SCHEDULED',
          priceVersion: 2,
        });
      }
      const empty = await request(app!.getHttpServer())
        .get(`/api/v1/precios/skus/unknown/programaciones`)
        .set('Authorization', `Bearer ${identity.token()}`)
        .expect(200);
      expect(empty.body).toEqual({
        items: [],
        meta: { pagina: 1, tamanio: 20, total: 0, totalPaginas: 0 },
      });
    });

    it('HTTP consulta un lote persistido sin filtrar row_input, report_uri ni detalle libre', async () => {
      const job = await repository.transaction(async (tx) => {
        const [job] = await tx
          .insert(bulkPriceJobs)
          .values({
            allowPartial: false,
            totalRows: 1,
            correlationId: randomUUID(),
            usuarioId: 'fixture-sensitive-actor',
            reportUri: 'https://private.invalid/secret',
          })
          .returning();
        await tx.insert(bulkPriceRows).values({
          batchId: job.id,
          rowId: '1',
          sku: '0001',
          rowInput: { secret: 'fixture-sensitive-input' },
          detail: 'fixture-sensitive-detail',
        });
        return job;
      });
      const response = await request(app!.getHttpServer())
        .get(`/api/v1/precios/importaciones/${job.id}`)
        .set('Authorization', `Bearer ${identity.token()}`)
        .expect(200);
      expect(response.body).toEqual({
        batch_id: job.id,
        status: 'QUEUED',
        allow_partial: false,
        total_rows: 1,
        completed_rows: 0,
        failed_rows: 0,
        rows: [{ row_id: '1', sku: '0001', status: 'PENDING' }],
      });
      expect(response.text).not.toMatch(/fixture-sensitive|private.invalid/);
      const absent = await request(app!.getHttpServer())
        .get(`/api/v1/precios/importaciones/${randomUUID()}`)
        .set('Authorization', `Bearer ${identity.token()}`)
        .expect(404);
      expect(absent.body.code).toBe('LOTE_NO_ENCONTRADO');
    });

    it('HTTP niega acceso y parámetros inválidos antes de consultar datos', async () => {
      const path = `/api/v1/precios/productos/${randomUUID()}/programaciones`;
      await request(app!.getHttpServer()).get(path).expect(401);
      const forbidden = await request(app!.getHttpServer())
        .get(path)
        .set('Authorization', `Bearer ${identity.token({ roles: ['OTRO'] })}`)
        .expect(403);
      expect(forbidden.body.code).toBe('SCOPE_INSUFICIENTE');
      for (const query of [
        'pagina=0',
        'pagina=1e2',
        'tamanio=201',
        'pagina=1&pagina=2',
        'canal=RETAIL',
        'pagina=9999999999999999999',
      ]) {
        const response = await request(app!.getHttpServer())
          .get(`${path}?${query}`)
          .set('Authorization', `Bearer ${identity.token()}`)
          .expect(400);
        expect(response.body.code).toBe('VALIDACION');
      }
      await request(app!.getHttpServer())
        .get(path)
        .set('Authorization', `Bearer ${identity.token()}`)
        .set('X-Correlation-Id', 'secret-not-uuid')
        .expect(400);
      await request(app!.getHttpServer())
        .get('/api/v1/precios/importaciones/not-uuid')
        .set('Authorization', `Bearer ${identity.token()}`)
        .expect(400);
    });

    it('#56: el caso de uso real serializa escritores y revierte precio/historia si falla Outbox', async () => {
      const productId = randomUUID();
      const now = new Date();
      await repository.transaction(async (tx) => {
        const [price] = await tx
          .insert(prices)
          .values({ productId })
          .returning();
        await tx.insert(priceValidities).values({
          ...snapshot(price.id),
          validFrom: new Date(now.getTime() - 60000),
        });
      });
      const fact = {
        messageId: randomUUID(),
        correlationId: randomUUID(),
        payload: {},
      };
      const input = {
        precioRegular: '120.00',
        accionPrecioOferta: 'CONSERVAR' as const,
        currency: 'PEN',
        motivoCambio: 'fixture-change',
        usuarioId: 'fixture-actor',
      };
      const results = await Promise.allSettled([
        mutations.update({ productId }, null, input, 1n, now, fact),
        mutations.update({ productId }, null, input, 1n, now, {
          ...fact,
          messageId: randomUUID(),
        }),
      ]);
      expect(
        results.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(1);
      expect(
        results.find((result) => result.status === 'rejected'),
      ).toMatchObject({ reason: { code: 'VERSION_CONFLICT' } });
      const definition = (await repository.findDefinition(
        { productId },
        null,
      ))!;
      expect(definition.priceVersion).toBe(2n);
      expect(await repository.findValidities(definition.id)).toHaveLength(2);
      const committedFacts = await database.db
        .select()
        .from(outbox)
        .where(eq(outbox.correlationId, fact.correlationId));
      expect(committedFacts).toHaveLength(1);
      await expect(
        mutations.update(
          { productId },
          null,
          input,
          2n,
          new Date(now.getTime() + 1000),
          { ...fact, messageId: committedFacts[0].messageId },
        ),
      ).rejects.toMatchObject({ sqlState: '23505' });
      expect(
        (await repository.findDefinition({ productId }, null))!.priceVersion,
      ).toBe(2n);
      expect(await repository.findValidities(definition.id)).toHaveLength(2);
      const facts = await database.db
        .select()
        .from(outbox)
        .where(eq(outbox.correlationId, fact.correlationId));
      expect(facts).toHaveLength(1);
      expect(facts[0]).toMatchObject({
        eventName: 'pricing.price.changed',
        publishedAt: null,
      });
    });

    it('#56: programa bajo lock sin versión cliente y conserva precio vigente hasta el inicio', async () => {
      const productId = randomUUID();
      const now = new Date();
      const future = new Date(now.getTime() + 3600000);
      await repository.transaction(async (tx) => {
        const [price] = await tx
          .insert(prices)
          .values({ productId })
          .returning();
        await tx.insert(priceValidities).values({
          ...snapshot(price.id),
          validFrom: new Date(now.getTime() - 60000),
        });
      });
      const input = {
        tipoPrecio: 'OFERTA' as const,
        importe: '70.00',
        currency: 'PEN',
        motivoCambio: 'fixture-schedule',
        usuarioId: 'fixture-actor',
        validFrom: future,
        validUntil: null,
      };
      const fact = () => ({
        messageId: randomUUID(),
        correlationId: randomUUID(),
        payload: {},
      });
      await mutations.schedule({ productId }, null, input, now, fact());
      const definition = (await repository.findDefinition(
        { productId },
        null,
      ))!;
      expect(definition.priceVersion).toBe(2n);
      const validities = await repository.findValidities(definition.id);
      expect(validities.map((value) => value.validUntil)).toEqual([
        future,
        null,
      ]);
      expect(
        await repository.readSchedules({ productId }, 1, 20),
      ).toMatchObject({ total: 1 });
      const current = await request(app!.getHttpServer())
        .get(`/api/v1/precios/productos/${productId}`)
        .set('Authorization', `Bearer ${identity.token()}`)
        .expect(200);
      expect(current.body).toMatchObject({
        precio_oferta: 80.25,
        price_version: 2,
      });
      await expect(
        mutations.schedule(
          { productId },
          null,
          {
            ...input,
            validFrom: new Date(future.getTime() - 1000),
            validUntil: new Date(future.getTime() + 1000),
          },
          now,
          fact(),
        ),
      ).rejects.toMatchObject({ code: 'VIGENCIA_SUPERPUESTA' });
      expect(
        (await repository.findDefinition({ productId }, null))!.priceVersion,
      ).toBe(2n);
    });

    it('HTTP no confunde falta de permisos DB con precio ausente y se recupera', async () => {
      await postgres.admin!.query(
        'REVOKE SELECT ON pricing.prices FROM pricing_app',
      );
      try {
        const response = await request(app!.getHttpServer())
          .get(`/api/v1/precios/productos/${randomUUID()}`)
          .set('Authorization', `Bearer ${identity.token()}`)
          .expect(503);
        expect(response.body.code).toBe('SERVICIO_NO_DISPONIBLE');
        expect(response.text).not.toMatch(
          /SELECT|permission|pricing_app|postgresql/,
        );
      } finally {
        await postgres.admin!.query(
          'GRANT SELECT ON pricing.prices TO pricing_app',
        );
      }
      await request(app!.getHttpServer())
        .get(`/api/v1/precios/productos/${randomUUID()}`)
        .set('Authorization', `Bearer ${identity.token()}`)
        .expect(404);
    });

    it('el mapping coincide con todas las columnas reales, nullabilidad y tipos', async () => {
      const { rows } = await postgres.admin!.query<{
        table_name: string;
        column_name: string;
        is_nullable: string;
        udt_name: string;
        numeric_precision: number;
        numeric_scale: number;
      }>(
        "SELECT * FROM information_schema.columns WHERE table_schema = 'pricing'",
      );
      for (const table of Object.values(pricingSchema)) {
        const config = getTableConfig(table);
        const actual = rows.filter((row) => row.table_name === config.name);
        expect(actual.map((row) => row.column_name).sort()).toEqual(
          config.columns.map((col) => col.name).sort(),
        );
        for (const col of config.columns) {
          const real = actual.find((row) => row.column_name === col.name)!;
          expect(real.is_nullable).toBe(col.notNull ? 'NO' : 'YES');
          const typeNames: Record<string, string> = {
            bigint: 'int8',
            integer: 'int4',
            boolean: 'bool',
            'char(3)': 'bpchar',
            'timestamp with time zone': 'timestamptz',
            'numeric(12,2)': 'numeric',
          };
          expect(real.udt_name).toBe(
            typeNames[col.getSQLType()] ?? col.getSQLType(),
          );
          if (col.getSQLType() === 'numeric(12,2)') {
            expect(real).toMatchObject({
              udt_name: 'numeric',
              numeric_precision: 12,
              numeric_scale: 2,
            });
          }
        }
      }
      const { rows: foreignKeys } = await postgres.admin!.query<{
        schema: string;
      }>(
        `SELECT n.nspname AS schema FROM pg_constraint c JOIN pg_class t ON t.oid=c.confrelid
       JOIN pg_namespace n ON n.oid=t.relnamespace WHERE c.contype='f' AND c.connamespace='pricing'::regnamespace`,
      );
      expect(foreignKeys).toHaveLength(3);
      expect(foreignKeys.every((fk) => fk.schema === 'pricing')).toBe(true);
    });

    it('inyecta provider/repositorio reales y comparte el pool con readiness', async () => {
      expect(await database.check()).toBe(true);
      await request(app!.getHttpServer()).get('/health/ready').expect(200);
      const { definition, validity } = await repository.transaction(
        async (tx) => {
          const result = await create(tx);
          await tx.insert(outbox).values(event());
          return result;
        },
      );
      expect(
        await repository.findDefinition(
          { productId: definition.productId! },
          null,
        ),
      ).toEqual(definition);
      expect(await repository.findValidities(definition.id)).toEqual([
        validity,
      ]);
      expect(validity).toMatchObject({
        precioRegular: '99.99',
        precioOferta: '80.25',
        priceVersion: 1n,
        validFrom: from,
      });
    });

    it('distingue producto/SKU y canal específico/global sin consultar Catálogo', async () => {
      const productId = randomUUID();
      await repository.transaction((tx) => create(tx, { productId }));
      await repository.transaction((tx) => create(tx, { productId }, 'WEB'));
      await repository.transaction(async (tx) => {
        const [p] = await tx
          .insert(prices)
          .values({ sku: productId })
          .returning();
        await tx.insert(priceValidities).values(snapshot(p.id));
      });
      const global = await repository.findDefinition({ productId }, null);
      const specific = await repository.findDefinition({ productId }, 'WEB');
      const sku = await repository.findDefinition({ sku: productId }, null);
      expect(new Set([global!.id, specific!.id, sku!.id]).size).toBe(3);
      await expect(
        repository.transaction((tx) => create(tx, { productId })),
      ).rejects.toMatchObject({ sqlState: '23505' });
    });

    it('revierte definición, snapshot, Inbox y Outbox juntos si falla el callback', async () => {
      const productId = randomUUID();
      const messageId = randomUUID();
      const rejection = new Error('rechazo intencional');
      await expect(
        repository.transaction(async (tx) => {
          await create(tx, { productId });
          await tx.insert(outbox).values({ ...event(), messageId });
          await tx.insert(inbox).values({
            messageId,
            handler: 'fixture',
            eventName: 'pricing.product.initialization.requested',
            payload: {},
            result: 'fixture',
          });
          throw rejection;
        }),
      ).rejects.toBe(rejection);
      expect(
        await repository.findDefinition({ productId }, null),
      ).toBeUndefined();
      for (const table of [outbox, inbox]) {
        expect(
          await database.db
            .select()
            .from(table)
            .where(eq(table.messageId, messageId)),
        ).toHaveLength(0);
      }
    });

    it('restricciones diferidas fallan en COMMIT y revierten también Outbox', async () => {
      const productId = randomUUID();
      const messageId = randomUUID();
      await expect(
        repository.transaction(async (tx) => {
          await tx.insert(prices).values({ productId });
          await tx.insert(outbox).values({ ...event(), messageId });
        }),
      ).rejects.toMatchObject({ sqlState: '23514' });
      expect(
        await repository.findDefinition({ productId }, null),
      ).toBeUndefined();
      expect(
        await database.db
          .select()
          .from(outbox)
          .where(eq(outbox.messageId, messageId)),
      ).toHaveLength(0);
    });

    it('enforce FK internas simples y compuestas', async () => {
      await expect(
        repository.transaction((tx) =>
          tx.insert(priceValidities).values(snapshot(randomUUID())),
        ),
      ).rejects.toMatchObject({ sqlState: '23503' });
      const a = await repository.transaction((tx) => create(tx));
      const b = await repository.transaction((tx) => create(tx));
      await expect(
        repository.transaction((tx) =>
          tx.insert(scheduledPrices).values({
            priceId: a.definition.id,
            validityId: b.validity.id,
            tipoPrecio: 'REGULAR',
            importe: '99.99',
          }),
        ),
      ).rejects.toMatchObject({ sqlState: '23503' });
    });

    it('protege dinero, XOR del objetivo e intervalos en PostgreSQL', async () => {
      await expect(
        repository.transaction((tx) =>
          tx.insert(prices).values({ productId: 'P', sku: 'S' }),
        ),
      ).rejects.toMatchObject({ sqlState: '23514' });
      for (const invalid of [
        { precioRegular: '0' },
        { precioOferta: '99.99' },
        { validUntil: from },
      ]) {
        await expect(
          repository.transaction(async (tx) => {
            const [p] = await tx
              .insert(prices)
              .values({ sku: randomUUID() })
              .returning();
            await tx
              .insert(priceValidities)
              .values({ ...snapshot(p.id), ...invalid });
          }),
        ).rejects.toMatchObject({ sqlState: '23514' });
      }
      await expect(
        repository.transaction(async (tx) => {
          const [p] = await tx
            .insert(prices)
            .values({ sku: randomUUID() })
            .returning();
          await tx
            .insert(priceValidities)
            .values({ ...snapshot(p.id), precioRegular: '1.001' });
        }),
      ).rejects.toThrow('precisión');
    });

    it('rechaza solapamiento y admite intervalos contiguos con versión CAS', async () => {
      const { definition, validity } = await repository.transaction((tx) =>
        create(tx),
      );
      await expect(
        repository.transaction(async (tx) => {
          await tx
            .update(prices)
            .set({ priceVersion: 2n })
            .where(eq(prices.id, definition.id));
          await tx
            .insert(priceValidities)
            .values({ ...snapshot(definition.id, 2n), validFrom: boundary });
        }),
      ).rejects.toMatchObject({ sqlState: '23P01' });
      await repository.transaction(async (tx) => {
        await tx
          .update(prices)
          .set({ priceVersion: 2n })
          .where(
            and(eq(prices.id, definition.id), eq(prices.priceVersion, 1n)),
          );
        await tx
          .update(priceValidities)
          .set({ validUntil: boundary })
          .where(eq(priceValidities.id, validity.id));
        await tx
          .insert(priceValidities)
          .values({ ...snapshot(definition.id, 2n), validFrom: boundary });
        await tx.insert(outbox).values(event());
      });
      expect(await repository.findValidities(definition.id)).toHaveLength(2);
      const stale = await repository.transaction((tx) =>
        tx
          .update(prices)
          .set({ priceVersion: 2n })
          .where(and(eq(prices.id, definition.id), eq(prices.priceVersion, 1n)))
          .returning(),
      );
      expect(stale).toHaveLength(0);
    });

    it('CAS concurrente admite un solo escritor y un solo Outbox', async () => {
      const { definition, validity } = await repository.transaction((tx) =>
        create(tx),
      );
      const messages = [event(), event()];
      const results = await Promise.all(
        messages.map((message) =>
          repository.transaction(async (tx) => {
            const changed = await tx
              .update(prices)
              .set({ priceVersion: 2n })
              .where(
                and(eq(prices.id, definition.id), eq(prices.priceVersion, 1n)),
              )
              .returning();
            if (!changed.length) return false;
            await tx
              .update(priceValidities)
              .set({ validUntil: boundary })
              .where(eq(priceValidities.id, validity.id));
            await tx
              .insert(priceValidities)
              .values({ ...snapshot(definition.id, 2n), validFrom: boundary });
            await tx.insert(outbox).values(message);
            return true;
          }),
        ),
      );
      expect(results.sort()).toEqual([false, true]);
      const rows = await database.db.select().from(outbox);
      expect(
        rows.filter((row) =>
          messages.some((message) => message.messageId === row.messageId),
        ),
      ).toHaveLength(1);
    });

    it('persiste programación coherente y lote local con filas durables', async () => {
      const { definition, validity } = await repository.transaction((tx) =>
        create(tx),
      );
      const [scheduled] = await repository.transaction((tx) =>
        tx
          .insert(scheduledPrices)
          .values({
            priceId: definition.id,
            validityId: validity.id,
            tipoPrecio: 'OFERTA',
            importe: '80.25',
          })
          .returning(),
      );
      expect(scheduled.status).toBe('SCHEDULED');
      await expect(
        repository.transaction((tx) =>
          tx
            .update(scheduledPrices)
            .set({ importe: '80.24' })
            .where(eq(scheduledPrices.id, scheduled.id)),
        ),
      ).rejects.toMatchObject({ sqlState: '23514' });
      const [job] = await repository.transaction((tx) =>
        tx
          .insert(bulkPriceJobs)
          .values({
            allowPartial: true,
            totalRows: 1,
            correlationId: randomUUID(),
          })
          .returning(),
      );
      const [row] = await repository.transaction((tx) =>
        tx
          .insert(bulkPriceRows)
          .values({ batchId: job.id, rowId: '1', rowInput: { sku: 'fixture' } })
          .returning(),
      );
      expect(row).toMatchObject({
        status: 'PENDING',
        rowInput: { sku: 'fixture' },
      });
      await expect(
        repository.transaction((tx) =>
          tx
            .insert(bulkPriceRows)
            .values({ batchId: job.id, rowId: '1', rowInput: {} }),
        ),
      ).rejects.toMatchObject({ sqlState: '23505' });
      await expect(
        repository.transaction((tx) =>
          tx
            .update(bulkPriceJobs)
            .set({ status: 'COMPLETED' })
            .where(eq(bulkPriceJobs.id, job.id)),
        ),
      ).rejects.toMatchObject({ sqlState: '23514' });
      await repository.transaction(async (tx) => {
        await tx
          .update(bulkPriceRows)
          .set({ status: 'COMPLETED' })
          .where(eq(bulkPriceRows.id, row.id));
        await tx
          .update(bulkPriceJobs)
          .set({ status: 'COMPLETED', completedRows: 1 })
          .where(eq(bulkPriceJobs.id, job.id));
      });
    });

    it('Inbox deduplica por mensaje/handler y Outbox por mensaje', async () => {
      const message = event();
      const received = {
        messageId: message.messageId,
        handler: 'fixture',
        eventName: 'pricing.product.initialization.requested',
        payload: {},
        result: 'fixture',
      };
      await repository.transaction(async (tx) => {
        await tx.insert(inbox).values(received);
        await tx.insert(outbox).values(message);
      });
      await expect(
        repository.transaction((tx) => tx.insert(inbox).values(received)),
      ).rejects.toMatchObject({ sqlState: '23505' });
      await expect(
        repository.transaction((tx) => tx.insert(outbox).values(message)),
      ).rejects.toMatchObject({ sqlState: '23505' });
      await repository.transaction((tx) =>
        tx.insert(inbox).values({ ...received, handler: 'otro' }),
      );
    });

    it('runtime sin ownership/DDL/DELETE/TRUNCATE ni acceso cross-schema', async () => {
      const privileges = await database.db.execute(sql`
        SELECT tablename AS name,
          has_table_privilege(current_user, schemaname || '.' || tablename, 'SELECT') AS read,
          has_table_privilege(current_user, schemaname || '.' || tablename, 'INSERT') AS insert,
          has_table_privilege(current_user, schemaname || '.' || tablename, 'UPDATE') AS update,
          has_table_privilege(current_user, schemaname || '.' || tablename, 'DELETE') AS delete,
          has_table_privilege(current_user, schemaname || '.' || tablename, 'TRUNCATE') AS truncate
        FROM pg_tables WHERE schemaname = 'pricing'`);
      expect(privileges.rows).toHaveLength(7);
      for (const row of privileges.rows) {
        expect(row).toEqual({
          name: row.name,
          read: true,
          insert: true,
          update: row.name !== 'inbox',
          delete: false,
          truncate: false,
        });
      }
      const result = await database.db.execute(sql`SELECT current_user AS role,
      pg_has_role(current_user, 'po_pricing_owner', 'MEMBER') AS owner,
      has_schema_privilege(current_user, 'pricing', 'CREATE') AS ddl`);
      expect(result.rows).toEqual([
        { role: 'pricing_app', owner: false, ddl: false },
      ]);
      for (const statement of [
        sql`DELETE FROM pricing.prices WHERE false`,
        sql`TRUNCATE pricing.prices`,
        sql`CREATE TABLE pricing.denied (id integer)`,
        sql`UPDATE pricing.inbox SET result = 'denied' WHERE false`,
        sql`SELECT * FROM foreign_fixture.secret`,
        sql`SET ROLE po_pricing_owner`,
      ]) {
        await expect(
          repository.transaction((tx) => tx.execute(statement)),
        ).rejects.toMatchObject({ sqlState: '42501' });
      }
      expect(await database.check()).toBe(true);
    });

    it('#54: planes de dominio persisten con CAS, histórico, programación y Outbox local', async () => {
      const productId = randomUUID();
      const initial = initializeProduct(
        {
          productId,
          skuBase: '000123',
          precioRegular: '100.00',
          currency: 'PEN',
          channelId: null,
          motivoCambio: 'ALTA_PRODUCTO',
        },
        from,
      ).definition;
      const priceId = await repository.transaction(async (tx) => {
        const [row] = await tx.insert(prices).values({ productId }).returning();
        await tx
          .insert(priceValidities)
          .values({ ...initial.validities[0], priceId: row.id });
        await tx.insert(outbox).values(event());
        return row.id;
      });
      async function persistPlan(plan: PriceDefinition, expected: bigint) {
        await repository.transaction(async (tx) => {
          const rows = await tx
            .update(prices)
            .set({ priceVersion: plan.priceVersion })
            .where(
              and(eq(prices.id, priceId), eq(prices.priceVersion, expected)),
            )
            .returning();
          if (rows.length !== 1) throw new Error('VERSION_CONFLICT');
          for (const validity of plan.validities) {
            if (validity.priceVersion === plan.priceVersion) {
              await tx.insert(priceValidities).values({ ...validity, priceId });
            } else {
              await tx
                .update(priceValidities)
                .set({ validUntil: validity.validUntil })
                .where(
                  and(
                    eq(priceValidities.priceId, priceId),
                    eq(priceValidities.priceVersion, validity.priceVersion),
                  ),
                );
            }
          }
          // Solo fixture de persistencia; no concreta el GenericData de producción.
          await tx.insert(outbox).values(event());
        });
      }
      const changed = changePrice(
        initial,
        {
          precioRegular: '120.00',
          accionPrecioOferta: 'CONSERVAR',
          currency: 'PEN',
          motivoCambio: 'fixture-update',
          usuarioId: 'fixture-actor',
        },
        1n,
        new Date('2030-02-01T00:00:00Z'),
      ).definition;
      await persistPlan(changed, 1n);
      const scheduled = schedulePrice(
        changed,
        {
          tipoPrecio: 'OFERTA',
          importe: '90.00',
          currency: 'PEN',
          motivoCambio: 'fixture-schedule',
          usuarioId: 'fixture-actor',
          validFrom: boundary,
          validUntil: null,
        },
        new Date('2030-03-01T00:00:00Z'),
      );
      await persistPlan(scheduled, 2n);
      const stored = await repository.findValidities(priceId);
      expect(stored.map((row) => row.priceVersion)).toEqual([1n, 2n, 3n]);
      expect(stored[0].validUntil).toEqual(changed.validities[0].validUntil);
      expect(stored[1].validUntil).toEqual(boundary);
      expect(stored[2]).toMatchObject({
        precioRegular: '120.00',
        precioOferta: '90.00',
        usuarioId: 'fixture-actor',
      });
      await expect(persistPlan(scheduled, 2n)).rejects.toThrow(
        'VERSION_CONFLICT',
      );
      expect(await repository.findValidities(priceId)).toHaveLength(3);
    });

    it('un error real DB queda sanitizado y el pool continúa operativo', async () => {
      const error = await repository
        .transaction((tx) =>
          tx.insert(priceValidities).values({
            ...snapshot(randomUUID()),
            motivoCambio: 'fixture-sensitive-value',
          }),
        )
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(PricingPersistenceError);
      expect(error).toMatchObject({ sqlState: '23503' });
      expect(JSON.stringify(error)).not.toMatch(
        /fixture-sensitive-value|insert into|postgresql/,
      );
      expect(await database.check()).toBe(true);
    });
  },
);
