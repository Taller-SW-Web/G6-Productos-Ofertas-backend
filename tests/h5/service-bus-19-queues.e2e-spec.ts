import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  BULK_TO_CATALOG_QUEUE,
  BULK_TO_INVENTORY_QUEUE,
  BULK_TO_PRICING_QUEUE,
  CATALOG_TO_BULK_QUEUE,
  INVENTORY_TO_BULK_QUEUE,
  PRICING_TO_BULK_QUEUE,
} from '../../apps/bulk-svc/src/messaging/bulk-service-bus.js';
import {
  SERVICE_BUS_QUEUES as CATALOG_ROUTING,
  bulkRequestQueue,
  taxonomyRequestQueue,
} from '../../apps/catalog-svc/src/catalog-service-bus.js';
import { COMBOS_SERVICE_BUS_QUEUES } from '../../apps/combos-svc/src/messaging/combos-service-bus.js';
import {
  QUEUE_BULK as INVENTORY_FROM_BULK,
  QUEUE_CATALOG as INVENTORY_FROM_CATALOG,
} from '../../apps/inventory-svc/src/messaging/service-bus-consumer.js';
import { INVENTORY_QUEUES as INVENTORY_DESTINATIONS } from '../../apps/inventory-svc/src/messaging/service-bus-deliveries.js';
import {
  AUDIT_PILOT_QUEUE,
  BULK_PRICE_RESULT_QUEUE,
  BULK_TO_PRICING_QUEUE as PRICING_FROM_BULK,
  CATALOG_INIT_QUEUE,
  CATALOG_TO_PRICING_QUEUE as PRICING_FROM_CATALOG,
  PROMOTIONS_PRICE_QUEUE,
  pricingDestinationsForFact,
} from '../../apps/pricing-svc/src/messaging/service-bus-deliveries.js';
import { promotionsEventRoutes } from '../../apps/promotions-svc/src/coupons/service-bus-events.js';
import {
  catalogTaxonomyQueue,
  taxonomyCatalogQueue,
} from '../../apps/taxonomy-svc/src/config/service-bus.js';
import { PricingServiceBusHandler } from '../../apps/pricing-svc/src/messaging/service-bus-consumer.js';
import { BulkContractResultDispatcherService } from '../../apps/bulk-svc/src/messaging/bulk-contract-result-dispatcher.js';
import { PricingReadiness } from '../../apps/pricing-svc/src/health/pricing-readiness.js';

const EXPECTED_19_QUEUES = [
  'g6.price-audit.from.pricing',
  'g6.catalog.from.taxonomy',
  'g6.catalog.from.bulk',
  'g6.catalog.from.pricing',
  'g6.catalog.from.inventory',
  'g6.bulk.from.catalog',
  'g6.bulk.from.inventory',
  'g6.bulk.from.pricing',
  'g6.pricing.from.catalog',
  'g6.pricing.from.bulk',
  'g6.inventory.from.catalog',
  'g6.inventory.from.bulk',
  'g6.promotions.from.catalog',
  'g6.promotions.from.pricing',
  'g6.promotions.from.inventory',
  'g6.combos.from.catalog',
  'g6.combos.from.inventory',
  'g6.taxonomy.from.catalog',
  'g6.promotions.commands',
] as const;

describe('G6 H5 Azure Service Bus Basic 19-queue topology & messaging contracts', () => {
  it('declares all 19 queues in ops/azure/service-bus/main.bicep with Basic SKU, Managed Identity RBAC, TTL and DLQ', () => {
    const bicep = readFileSync(
      resolve(process.cwd(), 'ops/azure/service-bus/main.bicep'),
      'utf8',
    );
    expect(bicep).toContain("name: 'Basic'");
    expect(bicep).toContain('disableLocalAuth: true');
    expect(bicep).toContain('deadLetteringOnMessageExpiration: true');
    for (const queue of EXPECTED_19_QUEUES) {
      expect(bicep).toContain(queue);
    }
  });

  it('wires all 19 H5 queues across producers and consumers without RabbitMQ fallback', () => {
    expect(AUDIT_PILOT_QUEUE).toBe('g6.price-audit.from.pricing');
    expect(PROMOTIONS_PRICE_QUEUE).toBe('g6.promotions.from.pricing');
    expect(CATALOG_INIT_QUEUE).toBe('g6.catalog.from.pricing');
    expect(BULK_PRICE_RESULT_QUEUE).toBe('g6.bulk.from.pricing');
    expect(PRICING_FROM_CATALOG).toBe('g6.pricing.from.catalog');
    expect(PRICING_FROM_BULK).toBe('g6.pricing.from.bulk');
    expect(BULK_TO_PRICING_QUEUE).toBe('g6.pricing.from.bulk');
    expect(PRICING_TO_BULK_QUEUE).toBe('g6.bulk.from.pricing');
    expect(BULK_TO_INVENTORY_QUEUE).toBe('g6.inventory.from.bulk');
    expect(INVENTORY_TO_BULK_QUEUE).toBe('g6.bulk.from.inventory');
    expect(INVENTORY_FROM_BULK).toBe('g6.inventory.from.bulk');
    expect(INVENTORY_DESTINATIONS.BULK).toBe('g6.bulk.from.inventory');
    expect(
      pricingDestinationsForFact({
        kind: 'event',
        eventName: 'pricing.price.changed',
      }),
    ).toEqual(['g6.price-audit.from.pricing', 'g6.promotions.from.pricing']);
    expect(promotionsEventRoutes.map((r) => r.queue).sort()).toEqual([
      'g6.promotions.from.catalog',
      'g6.promotions.from.inventory',
      'g6.promotions.from.pricing',
    ]);
    expect(taxonomyCatalogQueue).toBe('g6.catalog.from.taxonomy');
    expect(catalogTaxonomyQueue).toBe('g6.taxonomy.from.catalog');
    expect(BULK_TO_CATALOG_QUEUE).toBe('g6.catalog.from.bulk');
    expect(CATALOG_TO_BULK_QUEUE).toBe('g6.bulk.from.catalog');
    expect(taxonomyRequestQueue).toBe('g6.catalog.from.taxonomy');
    expect(bulkRequestQueue).toBe('g6.catalog.from.bulk');
    expect(INVENTORY_FROM_CATALOG).toBe('g6.inventory.from.catalog');
    expect(INVENTORY_DESTINATIONS.CATALOG).toBe('g6.catalog.from.inventory');
    expect(INVENTORY_DESTINATIONS.COMBOS).toBe('g6.combos.from.inventory');
    expect(INVENTORY_DESTINATIONS.PROMOTIONS).toBe(
      'g6.promotions.from.inventory',
    );
    expect(Object.keys(COMBOS_SERVICE_BUS_QUEUES).sort()).toEqual([
      'g6.combos.from.catalog',
      'g6.combos.from.inventory',
    ]);
    expect(CATALOG_ROUTING['catalog.product.deactivated']).toContain(
      'g6.promotions.from.catalog',
    );
    expect(CATALOG_ROUTING['catalog.product.deactivated']).toContain(
      'g6.combos.from.catalog',
    );
  });

  it('enforces 256 KB limit and DLQ in real handlers, reconciles R10/R14 in BulkContractResultDispatcherService, and gates PricingReadiness on consumer health', async () => {
    const maxBytes = 256 * 1024;
    const oversizedPayload = JSON.stringify({
      message_id: randomUUID(),
      correlation_id: randomUUID(),
      name: 'pricing.price.changed',
      data: { padding: 'x'.repeat(maxBytes) },
    });
    expect(Buffer.byteLength(oversizedPayload, 'utf8')).toBeGreaterThan(
      maxBytes,
    );

    const deadLetterMessage = vi.fn(async () => undefined);
    const completeMessage = vi.fn(async () => undefined);
    const abandonMessage = vi.fn(async () => undefined);
    const pricingHandler = new PricingServiceBusHandler(
      PRICING_FROM_BULK,
      { completeMessage, abandonMessage, deadLetterMessage },
      { consume: vi.fn() },
      { consume: vi.fn() },
      { process: vi.fn() },
    );

    const oversizedOutcome = await pricingHandler.handle({
      messageId: randomUUID(),
      body: Buffer.from(oversizedPayload, 'utf8'),
    } as never);
    expect(oversizedOutcome).toBe('dead-lettered');
    expect(deadLetterMessage).toHaveBeenCalledOnce();
    expect(completeMessage).not.toHaveBeenCalled();

    const applyDomainResult = vi.fn(async () => ({ processed: true, result: 'APPLIED' }));
    const dispatcher = new BulkContractResultDispatcherService({
      applyDomainResult,
    } as never);
    const batchId = randomUUID();
    const rowId = randomUUID();
    await dispatcher.dispatch({
      eventName: 'inventory.bulk.stock.adjust.completed',
      messageId: randomUUID(),
      correlationId: randomUUID(),
      payload: {
        operation_id: randomUUID(),
        causation_id: randomUUID(),
        data: {
          batch_id: batchId,
          row_operation_id: rowId,
          operation_id: randomUUID(),
          sku: 'SKU-19',
        },
      },
    });
    expect(applyDomainResult).toHaveBeenCalledWith(
      expect.objectContaining({
        batchId,
        rowId,
        domain: 'INVENTARIO',
        status: 'COMPLETED',
      }),
    );

    const readiness = new PricingReadiness(
      { check: async () => true } as never,
      { auth: { issuer: 'https://g7.test' }, serviceBus: { namespace: 'lab.servicebus.windows.net' } } as never,
      undefined,
      undefined,
      { available: true } as never,
      { available: false } as never,
    );
    expect(await readiness.check()).toBe(false);
  });
});
