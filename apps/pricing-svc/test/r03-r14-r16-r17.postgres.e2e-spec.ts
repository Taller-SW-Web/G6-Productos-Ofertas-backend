import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { INestApplication } from '@nestjs/common';
import type { ServiceBusReceivedMessage } from '@azure/service-bus';
import { Test } from '@nestjs/testing';
import { describe, afterAll, beforeAll, expect, it, vi } from 'vitest';
import { PricingSvcModule } from '../src/pricing-svc.module.js';
import { BulkPriceApplyService } from '../src/messaging/bulk-price-apply.service.js';
import { PricingProductInitialization } from '../src/messaging/pricing-initialization.js';
import { PRICING_CATALOG_CONTEXT } from '../src/http/commercial-prices.js';
import {
  PricingServiceBusConsumer,
  PricingServiceBusHandler,
} from '../src/messaging/service-bus-consumer.js';
import { PricingServiceBusRuntime } from '../src/messaging/service-bus-relay.js';
import {
  AUDIT_PILOT_QUEUE,
  BULK_PRICE_RESULT_QUEUE,
  BULK_TO_PRICING_QUEUE,
  CATALOG_INIT_QUEUE,
  PROMOTIONS_PRICE_QUEUE,
} from '../src/messaging/service-bus-deliveries.js';
import { IsolatedPostgres } from './isolated-postgres.js';

describe.skipIf(process.env.PRICING_TEST_POSTGRES !== '1')(
  'Pricing R03 -> R14/R16/R17 PostgreSQL descartable (ESCRITA_NO_EJECUTADA)',
  () => {
    const postgres = new IsolatedPostgres();
    let app: INestApplication;
    let bulkApply: BulkPriceApplyService;

    beforeAll(async () => {
      await postgres.start();
      const outboxDeliverySql = await readFile(
        new URL(
          '../migrations-candidate/h5/0001_outbox_delivery.sql',
          import.meta.url,
        ),
        'utf8',
      );
      const h5RoutesSql = await readFile(
        new URL(
          '../migrations/0003_service_bus_h5_routes_r2.sql',
          import.meta.url,
        ),
        'utf8',
      );
      await postgres.admin!.query('BEGIN');
      try {
        await postgres.admin!.query('SET LOCAL ROLE po_pricing_owner');
        await postgres.admin!.query(outboxDeliverySql);
        await postgres.admin!.query(h5RoutesSql);
        await postgres.admin!.query('COMMIT');
      } catch (err) {
        await postgres.admin!.query('ROLLBACK');
        throw err;
      }
      process.env.MESSAGING_PROVIDER = 'AZURE_SERVICE_BUS';
      const moduleRef = await Test.createTestingModule({
        imports: [
          PricingSvcModule.forRoot({
            NODE_ENV: 'test',
            PORT: '3002',
            DATABASE_URL: postgres.runtimeUrl,
            AUTH_ISSUER: 'https://isolated.test/issuer',
            AUTH_JWKS_URL: 'https://isolated.test/jwks',
            PRICING_SERVICE_TOKEN_URL:
              'https://isolated.test/api/v1/auth/token',
            PRICING_SERVICE_CLIENT_SECRET: 'fixture-secret',
            PRICING_CATALOG_URL: 'https://isolated.test',
            MESSAGING_PROVIDER: 'AZURE_SERVICE_BUS',
            G6_SERVICE_BUS_PILOT_ENABLED: 'true',
            PRICING_PRICE_CHANGED_PUBLISH_ENABLED: 'true',
            SERVICE_BUS_NAMESPACE_FQDN:
              'fixture-pricing.servicebus.windows.net',
          }),
        ],
      })
        .overrideProvider(PRICING_CATALOG_CONTEXT)
        .useValue({
          resolve: async (sku: string) => ({
            sku,
            productId: 'contract-product',
            isVariant: false,
            active: false,
            eligible: false,
          }),
        })
        .overrideProvider(PricingServiceBusRuntime)
        .useValue({ available: true })
        .overrideProvider(PricingServiceBusConsumer)
        .useValue({ available: true })
        .compile();

      app = moduleRef.createNestApplication({ logger: false });
      await app.init();
      bulkApply = app.get(BulkPriceApplyService);
    });

    afterAll(async () => {
      await app?.close();
      await postgres.stop();
    });

    it('persists valid bulk prices, rejects 0.00/invalid offer, and writes R14 + R16 + R17 deliveries in PostgreSQL', async () => {
      const messageId = randomUUID();
      const operationId = randomUUID();
      const correlationId = randomUUID();
      const batchId = randomUUID();
      const settlement = {
        completeMessage: vi.fn().mockResolvedValue(undefined),
        abandonMessage: vi.fn().mockResolvedValue(undefined),
        deadLetterMessage: vi.fn().mockResolvedValue(undefined),
      };
      const handler = new PricingServiceBusHandler(
        BULK_TO_PRICING_QUEUE,
        settlement,
        { consume: vi.fn() },
        { consume: vi.fn() },
        bulkApply,
      );

      const outcome = await handler.handle({
        messageId,
        subject: 'pricing.bulk.price.apply.requested',
        body: Buffer.from(
          JSON.stringify({
            message_id: messageId,
            operation_id: operationId,
            correlation_id: correlationId,
            producer: 'bulk-svc',
            kind: 'command',
            name: 'pricing.bulk.price.apply.requested',
            data: {
              batch_id: batchId,
              batch_operation_id: randomUUID(),
              items: [
                {
                  row_number: 2,
                  row_operation_id: randomUUID(),
                  sku: 'PG-SKU-OK',
                  precio_regular: '45.00',
                  precio_oferta: '35.00',
                  currency: 'PEN',
                },
                {
                  row_number: 3,
                  row_operation_id: randomUUID(),
                  sku: 'PG-SKU-ZERO',
                  precio_regular: '0.00',
                  currency: 'PEN',
                },
                {
                  row_number: 4,
                  row_operation_id: randomUUID(),
                  sku: 'PG-SKU-BAD-OFFER',
                  precio_regular: '20.00',
                  precio_oferta: '25.00',
                  currency: 'PEN',
                },
              ],
            },
          }),
        ),
      } as unknown as ServiceBusReceivedMessage);

      expect(outcome).toBe('completed');
      expect(settlement.completeMessage).toHaveBeenCalledOnce();

      const validities = await postgres.admin!.query<{
        sku: string;
        precio_regular: string;
        precio_oferta: string | null;
      }>(
        `SELECT pv.precio_regular::text, pv.precio_oferta::text, p.sku
         FROM pricing.price_validities pv
         JOIN pricing.prices p ON p.id = pv.price_id
         WHERE pv.is_cancelled = false`,
      );
      expect(validities.rows).toEqual([
        expect.objectContaining({
          sku: 'PG-SKU-OK',
          precio_regular: '45.00',
          precio_oferta: '35.00',
        }),
      ]);

      const deliveries = await postgres.admin!.query<{
        destination: string;
        event_name: string;
      }>(
        `SELECT d.destination, o.event_name
         FROM pricing.outbox_delivery d
         JOIN pricing.outbox o ON o.message_id = d.message_id
         WHERE o.correlation_id = $1`,
        [correlationId],
      );
      const pairs = deliveries.rows.map(
        (r) => `${r.event_name}->${r.destination}`,
      );
      expect(pairs).toContain(`pricing.price.changed->${AUDIT_PILOT_QUEUE}`);
      expect(pairs).toContain(
        `pricing.price.changed->${PROMOTIONS_PRICE_QUEUE}`,
      );
      expect(pairs).toContain(
        `pricing.bulk.price.apply.completed->${BULK_PRICE_RESULT_QUEUE}`,
      );
      expect(
        deliveries.rows.filter((r) => r.event_name === 'pricing.price.changed'),
      ).toHaveLength(4);
    });

    it.each([
      [90, 'APPLIED', 'completed'],
      [0, 'REJECTED', 'rejected'],
    ] as const)(
      'persists the R15 delivery atomically for initial price %i and deduplicates redelivery',
      async (amount, outcome, suffix) => {
        const initialization = app.get(PricingProductInitialization);
        const messageId = randomUUID();
        const operationId = randomUUID();
        const raw = Buffer.from(
          JSON.stringify({
            message_id: messageId,
            schema_version: 1,
            occurred_at: new Date().toISOString(),
            correlation_id: randomUUID(),
            causation_id: null,
            operation_id: operationId,
            producer: 'catalog-svc',
            kind: 'command',
            name: 'pricing.product.initialization.requested',
            data: {
              product_id: randomUUID(),
              sku_base: `R15-${randomUUID()}`,
              precio_regular: amount,
              moneda: 'PEN',
              channel_id: null,
              motivo_cambio: 'ALTA_PRODUCTO',
            },
          }),
        );
        expect(await initialization.consume(raw)).toBe(outcome);
        const deliveries = () =>
          postgres.admin!.query(
            `SELECT o.event_name, o.causation_id, d.destination
         FROM pricing.outbox o JOIN pricing.outbox_delivery d USING (message_id)
         WHERE o.operation_id = $1 AND o.kind = 'result'`,
            [operationId],
          );
        expect((await deliveries()).rows).toEqual([
          {
            event_name: `pricing.product.initialization.${suffix}`,
            causation_id: messageId,
            destination: CATALOG_INIT_QUEUE,
          },
        ]);
        await initialization.consume(raw);
        expect((await deliveries()).rows).toHaveLength(1);
      },
    );
  },
);
