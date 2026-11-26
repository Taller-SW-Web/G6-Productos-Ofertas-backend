import { randomUUID } from 'node:crypto';
import type { ServiceBusReceivedMessage } from '@azure/service-bus';
import { describe, expect, it, vi } from 'vitest';
import {
  AUDIT_PILOT_QUEUE,
  BULK_PRICE_RESULT_QUEUE,
  BULK_TO_PRICING_QUEUE,
  CATALOG_INIT_QUEUE,
  CATALOG_TO_PRICING_QUEUE,
  PROMOTIONS_PRICE_QUEUE,
  pricingDestinationsForFact,
} from './service-bus-deliveries.js';
import { PricingServiceBusHandler } from './service-bus-consumer.js';
import { PricingServiceBusRelay } from './service-bus-relay.js';
import { BulkPriceApplyService } from './bulk-price-apply.service.js';
import { BulkServiceBus } from '../../../bulk-svc/src/messaging/bulk-service-bus.js';

describe('Pricing H5 Service Bus R03, R07, R14, R15, R16, R17 (ESCRITA_NO_EJECUTADA)', () => {
  it('routes pricing.price.changed to both R16 (Price Audit) and R17 (Promotions) and R14/R15 results to Bulk/Catalog', () => {
    expect(
      pricingDestinationsForFact({
        kind: 'event',
        eventName: 'pricing.price.changed',
      }),
    ).toEqual([AUDIT_PILOT_QUEUE, PROMOTIONS_PRICE_QUEUE]);
    expect(
      pricingDestinationsForFact({
        kind: 'result',
        eventName: 'pricing.product.initialization.completed',
      }),
    ).toEqual([CATALOG_INIT_QUEUE]);
    expect(
      pricingDestinationsForFact({
        kind: 'result',
        eventName: 'pricing.bulk.price.apply.completed',
      }),
    ).toEqual([BULK_PRICE_RESULT_QUEUE]);
    expect(
      pricingDestinationsForFact({
        kind: 'result',
        eventName: 'pricing.bulk.price.apply.rejected',
      }),
    ).toEqual([BULK_PRICE_RESULT_QUEUE]);
  });

  it('publishes R03 command from BulkServiceBus to g6.pricing.from.bulk and consumes R14 result on g6.bulk.from.pricing', async () => {
    const sentBatches: unknown[] = [];
    const sender = {
      createMessageBatch: vi.fn().mockResolvedValue({
        tryAddMessage: vi.fn((m: unknown) => {
          sentBatches.push(m);
          return true;
        }),
      }),
      sendMessages: vi.fn().mockResolvedValue(undefined),
    };
    const receiver = {
      subscribe: vi.fn().mockReturnValue({ close: vi.fn() }),
      peekMessages: vi.fn().mockResolvedValue([]),
      completeMessage: vi.fn().mockResolvedValue(undefined),
      abandonMessage: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const client = {
      createSender: vi.fn().mockReturnValue(sender),
      createReceiver: vi.fn().mockReturnValue(receiver),
      close: vi.fn().mockResolvedValue(undefined),
    };

    const bus = new BulkServiceBus(client as never);
    const messageId = randomUUID();
    const correlationId = randomUUID();
    await bus.publishPricingCommand({
      messageId,
      correlationId,
      eventName: 'pricing.bulk.price.apply.requested',
      payload: {
        message_id: messageId,
        correlation_id: correlationId,
        name: 'pricing.bulk.price.apply.requested',
        producer: 'bulk-svc',
        kind: 'command',
        data: { batch_id: randomUUID(), items: [] },
      },
    });
    expect(client.createSender).toHaveBeenCalledWith(BULK_TO_PRICING_QUEUE);
    expect(sentBatches).toHaveLength(1);

    const consumer = {
      consumeServiceBusMessage: vi.fn().mockResolvedValue(undefined),
    };
    bus.subscribePricingResults(consumer, vi.fn());
    expect(client.createReceiver).toHaveBeenCalledWith(
      BULK_PRICE_RESULT_QUEUE,
      expect.objectContaining({ receiveMode: 'peekLock' }),
    );
  });

  it('handles R03 on g6.pricing.from.bulk and R07 on g6.pricing.from.catalog with DLQ on unauthorized producer', async () => {
    const settlement = {
      completeMessage: vi.fn().mockResolvedValue(undefined),
      abandonMessage: vi.fn().mockResolvedValue(undefined),
      deadLetterMessage: vi.fn().mockResolvedValue(undefined),
    };
    const initialization = { consume: vi.fn().mockResolvedValue('APPLIED') };
    const deactivation = { consume: vi.fn().mockResolvedValue('APPLIED') };
    const bulkApply = {
      process: vi.fn().mockResolvedValue({
        status: 'APPLIED',
        resultEventName: 'pricing.bulk.price.apply.completed',
      }),
    };

    const bulkHandler = new PricingServiceBusHandler(
      BULK_TO_PRICING_QUEUE,
      settlement,
      initialization,
      deactivation,
      bulkApply,
    );
    const id1 = randomUUID();
    const validBulkMsg = {
      messageId: id1,
      subject: 'pricing.bulk.price.apply.requested',
      body: Buffer.from(
        JSON.stringify({
          message_id: id1,
          operation_id: randomUUID(),
          correlation_id: randomUUID(),
          producer: 'bulk-svc',
          kind: 'command',
          name: 'pricing.bulk.price.apply.requested',
          data: { items: [{ sku: 'SKU-1', precio_regular: '10.00', currency: 'PEN' }] },
        }),
      ),
    } as unknown as ServiceBusReceivedMessage;
    expect(await bulkHandler.handle(validBulkMsg)).toBe('completed');
    expect(bulkApply.process).toHaveBeenCalledOnce();
    expect(settlement.completeMessage).toHaveBeenCalledWith(validBulkMsg);

    const catalogHandler = new PricingServiceBusHandler(
      CATALOG_TO_PRICING_QUEUE,
      settlement,
      initialization,
      deactivation,
      bulkApply,
    );
    const id2 = randomUUID();
    const unauthorizedMsg = {
      messageId: id2,
      subject: 'pricing.product.initialization.requested',
      body: Buffer.from(
        JSON.stringify({
          message_id: id2,
          producer: 'bulk-svc',
          name: 'pricing.product.initialization.requested',
        }),
      ),
    } as unknown as ServiceBusReceivedMessage;
    expect(await catalogHandler.handle(unauthorizedMsg)).toBe('dead-lettered');
    expect(settlement.deadLetterMessage).toHaveBeenCalledWith(
      unauthorizedMsg,
      expect.objectContaining({ deadLetterReason: 'INVALID_MESSAGE' }),
    );
  });

  it('relays R14/R15/R16/R17 deliveries to destination-specific senders and keeps pending on timeout', async () => {
    const messageId = randomUUID();
    const correlationId = randomUUID();
    const store = {
      claim: vi.fn().mockResolvedValue({
        token: randomUUID(),
        destination: BULK_PRICE_RESULT_QUEUE,
        row: {
          messageId,
          correlationId,
          causationId: randomUUID(),
          operationId: randomUUID(),
          kind: 'result',
          eventName: 'pricing.bulk.price.apply.completed',
          schemaVersion: 1,
          occurredAt: new Date(),
          payload: { batch_id: randomUUID(), results: [] },
        },
      }),
      finish: vi.fn().mockResolvedValue(true),
    };
    const sender = {
      createMessageBatch: vi.fn().mockResolvedValue({
        tryAddMessage: vi.fn().mockReturnValue(true),
      }),
      sendMessages: vi.fn().mockRejectedValue(new Error('ETIMEDOUT')),
    };
    const relay = new PricingServiceBusRelay(store as never, () => sender);
    expect(await relay.publishOne()).toBe('pending');
    expect(store.finish).toHaveBeenCalledWith(expect.anything(), false);
  });

  it('executes real BulkPriceApplyService via PricingServiceBusHandler: rejects 0.00/invalid offer and emits pricing.price.changed + R14 for applied rows', async () => {
    const insertedOutbox: Array<{ eventName: string; payload: Record<string, unknown> }> = [];
    const insertedDeliveries: Array<{ destination: string }> = [];
    const tx = {
      execute: vi.fn().mockResolvedValue(undefined),
      select: vi.fn().mockImplementation(() => ({
        from: () => ({
          where: () => ({
            limit: async () => [],
            then: (resolve: (v: unknown[]) => void) => resolve([]),
          }),
        }),
      })),
      insert: vi.fn().mockImplementation((table: unknown) => ({
        values: (vals: unknown) => {
          const rows = Array.isArray(vals) ? vals : [vals];
          const tableObj = table as Record<symbol, string>;
          const tableName = String(Object.values(tableObj)[0] ?? '');
          if (rows[0] && typeof rows[0] === 'object' && 'eventName' in rows[0]) {
            for (const r of rows) {
              insertedOutbox.push({
                eventName: String((r as Record<string, unknown>).eventName),
                payload: (r as Record<string, unknown>).payload as Record<string, unknown>,
              });
            }
          }
          if (rows[0] && typeof rows[0] === 'object' && 'destination' in rows[0]) {
            for (const r of rows) {
              insertedDeliveries.push({
                destination: String((r as Record<string, unknown>).destination),
              });
            }
          }
          return {
            onConflictDoNothing: async () => undefined,
            onConflictDoUpdate: () => ({
              returning: async () => [
                { id: randomUUID(), productId: randomUUID(), priceVersion: 1n },
              ],
            }),
            returning: async () =>
              rows.map((r) => ({
                id: randomUUID(),
                priceVersion: 1n,
                ...(typeof r === 'object' && r !== null ? r : {}),
              })),
          };
        },
      })),
      update: vi.fn().mockImplementation(() => ({
        set: () => ({
          where: async () => undefined,
        }),
      })),
    };
    const repo = {
      transaction: vi.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(tx)),
    };
    const service = new BulkPriceApplyService(repo as never, {
      serviceBus: { namespace: 'lab.servicebus.windows.net' },
    } as never);
    const handler = new PricingServiceBusHandler(
      BULK_TO_PRICING_QUEUE,
      {
        completeMessage: vi.fn().mockResolvedValue(undefined),
        abandonMessage: vi.fn().mockResolvedValue(undefined),
        deadLetterMessage: vi.fn().mockResolvedValue(undefined),
      },
      { consume: vi.fn() },
      { consume: vi.fn() },
      service,
    );

    const messageId = randomUUID();
    const outcome = await handler.handle({
      messageId,
      subject: 'pricing.bulk.price.apply.requested',
      body: Buffer.from(
        JSON.stringify({
          message_id: messageId,
          operation_id: randomUUID(),
          correlation_id: randomUUID(),
          producer: 'bulk-svc',
          kind: 'command',
          name: 'pricing.bulk.price.apply.requested',
          data: {
            batch_id: randomUUID(),
            batch_operation_id: randomUUID(),
            items: [
              {
                row_number: 2,
                row_operation_id: randomUUID(),
                sku: 'SKU-OK',
                precio_regular: '25.00',
                precio_oferta: '19.90',
                currency: 'PEN',
              },
              {
                row_number: 3,
                row_operation_id: randomUUID(),
                sku: 'SKU-ZERO',
                precio_regular: '0.00',
                currency: 'PEN',
              },
              {
                row_number: 4,
                row_operation_id: randomUUID(),
                sku: 'SKU-BAD-OFFER',
                precio_regular: '10.00',
                precio_oferta: '12.00',
                currency: 'PEN',
              },
            ],
          },
        }),
      ),
    } as unknown as ServiceBusReceivedMessage);

    expect(outcome).toBe('completed');
    const changedFacts = insertedOutbox.filter(
      (f) => f.eventName === 'pricing.price.changed',
    );
    expect(changedFacts).toHaveLength(2);
    expect(changedFacts.every((f) => f.payload.sku === 'SKU-OK')).toBe(true);
    expect(
      insertedOutbox.some(
        (f) => f.eventName === 'pricing.bulk.price.apply.completed',
      ),
    ).toBe(true);
    expect(insertedDeliveries.map((d) => d.destination)).toContain(
      AUDIT_PILOT_QUEUE,
    );
    expect(insertedDeliveries.map((d) => d.destination)).toContain(
      PROMOTIONS_PRICE_QUEUE,
    );
    expect(insertedDeliveries.map((d) => d.destination)).toContain(
      BULK_PRICE_RESULT_QUEUE,
    );
  });
});
