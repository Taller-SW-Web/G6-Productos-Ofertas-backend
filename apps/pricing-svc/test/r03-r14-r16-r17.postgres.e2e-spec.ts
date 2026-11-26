import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { ServiceBusReceivedMessage } from '@azure/service-bus';
import { Test } from '@nestjs/testing';
import { describe, afterAll, beforeAll, expect, it, vi } from 'vitest';
import { PricingSvcModule } from '../src/pricing-svc.module.js';
import { BulkPriceApplyService } from '../src/messaging/bulk-price-apply.service.js';
import { PricingServiceBusHandler } from '../src/messaging/service-bus-consumer.js';
import {
  AUDIT_PILOT_QUEUE,
  BULK_PRICE_RESULT_QUEUE,
  BULK_TO_PRICING_QUEUE,
  PROMOTIONS_PRICE_QUEUE,
} from '../src/messaging/service-bus-deliveries.js';
import { PricingDatabase } from '../src/persistence/pricing.database.js';
import { PRICING_CONFIG } from '../src/config/environment.js';
import { IsolatedPostgres } from './isolated-postgres.js';

describe.skipIf(process.env.PRICING_TEST_POSTGRES !== '1')(
  'Pricing R03 -> R14/R16/R17 PostgreSQL descartable (ESCRITA_NO_EJECUTADA)',
  () => {
    const postgres = new IsolatedPostgres();
    let app: INestApplication;
    let bulkApply: BulkPriceApplyService;
    let database: PricingDatabase;

    beforeAll(async () => {
      await postgres.start();
      process.env.MESSAGING_PROVIDER = 'AZURE_SERVICE_BUS';
      const moduleRef = await Test.createTestingModule({
        imports: [PricingSvcModule],
      })
        .overrideProvider(PRICING_CONFIG)
        .useValue({
          databaseUrl: postgres.url,
          serviceBus: { namespace: 'lab-r2.servicebus.windows.net' },
          auth: { issuer: 'https://isolated.test/issuer', jwksUrl: 'https://isolated.test/jwks' },
        })
        .compile();
      app = moduleRef.createNestApplication({ logger: false });
      await app.init();
      bulkApply = app.get(BulkPriceApplyService);
      database = app.get(PricingDatabase);
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
              ],
            },
          }),
        ),
      } as unknown as ServiceBusReceivedMessage);

      expect(outcome).toBe('completed');
      expect(settlement.completeMessage).toHaveBeenCalledOnce();

      const validities = await database.pool.query(
        `SELECT pv.precio_regular, pv.precio_oferta, p.sku
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

      const deliveries = await database.pool.query(
        `SELECT d.destination, o.event_name
         FROM pricing.outbox_delivery d
         JOIN pricing.outbox o ON o.message_id = d.message_id
         WHERE o.correlation_id = $1`,
        [correlationId],
      );
      const pairs = deliveries.rows.map((r) => `${r.event_name}->${r.destination}`);
      expect(pairs).toContain(`pricing.price.changed->${AUDIT_PILOT_QUEUE}`);
      expect(pairs).toContain(`pricing.price.changed->${PROMOTIONS_PRICE_QUEUE}`);
      expect(pairs).toContain(`pricing.bulk.price.apply.completed->${BULK_PRICE_RESULT_QUEUE}`);
    });
  },
);
