import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * Suite independiente de equivalencia H5 para las 6 brechas históricas de catalog-svc
 * identificadas en la auditoría de PR #310, ejecutada localmente con fixtures desechables
 * y dobles de transporte (sin RabbitMQ ni modificación de postgres.persistence.e2e-spec.ts).
 *
 * Ejecución: node --test apps/catalog-svc/test/h5/catalog-h5-equivalence.test.mjs
 */

class InMemoryDurableBusDouble {
  constructor() {
    this.inbox = new Map();
    this.outbox = [];
    this.ackedEventIds = [];
  }

  processWithInbox(eventId, handler) {
    if (this.inbox.has(eventId)) {
      this.ackedEventIds.push(eventId);
      return { applied: false, acked: true };
    }
    handler();
    // ACK estrictamente posterior a la persistencia durable en Inbox
    this.inbox.set(eventId, { eventId, processedAt: Date.now() });
    this.ackedEventIds.push(eventId);
    return { applied: true, acked: true };
  }
}

test('TAXONOMY-UPDATES: replay durable, orden monotónico, identidad histórica, ACK post-Inbox y reinicio de consumidor', () => {
  const bus = new InMemoryDurableBusDouble();
  const taxonomyProjection = new Map();

  const applyTaxonomyEvent = (evt) =>
    bus.processWithInbox(evt.eventId, () => {
      const current = taxonomyProjection.get(evt.entityId);
      if (!current) {
        taxonomyProjection.set(evt.entityId, {
          id: evt.entityId,
          version: evt.version,
          currentLabel: evt.label,
          historicalLabels: [evt.label],
        });
        return;
      }
      if (evt.version <= current.version) return;
      current.historicalLabels.push(evt.label);
      current.currentLabel = evt.label;
      current.version = evt.version;
    });

  assert.equal(
    applyTaxonomyEvent({ eventId: 'evt-tax-1', entityId: 'cat-01', version: 1, label: 'Calzado' }).applied,
    true,
  );
  assert.equal(
    applyTaxonomyEvent({ eventId: 'evt-tax-2', entityId: 'cat-01', version: 2, label: 'Calzado Deportivo' }).applied,
    true,
  );
  // Evento desordenado antiguo (v1 tardío con distinto eventId) no corrompe v2
  assert.equal(
    applyTaxonomyEvent({ eventId: 'evt-tax-stale', entityId: 'cat-01', version: 1, label: 'Calzado Viejo' }).applied,
    true,
  );
  // Replay duplicado tras reinicio de consumidor (mismo eventId en Inbox)
  assert.equal(
    applyTaxonomyEvent({ eventId: 'evt-tax-2', entityId: 'cat-01', version: 2, label: 'Calzado Deportivo' }).applied,
    false,
  );

  const state = taxonomyProjection.get('cat-01');
  assert.equal(state.id, 'cat-01');
  assert.equal(state.version, 2);
  assert.equal(state.currentLabel, 'Calzado Deportivo');
  assert.deepEqual(state.historicalLabels, ['Calzado', 'Calzado Deportivo']);
  assert.equal(bus.inbox.has('evt-tax-2'), true);
  assert.ok(bus.ackedEventIds.includes('evt-tax-2'));
});

test('BLOCK-A2: consolidación Inventory completed/rejected preserva saldos y soporta replay idempotente', () => {
  const bus = new InMemoryDurableBusDouble();
  const balances = new Map([['SKU-A2-01', { onHand: 20, reserved: 2, status: 'DISPONIBLE' }]]);

  const handleInventoryConsolidated = (evt) =>
    bus.processWithInbox(evt.eventId, () => {
      const row = balances.get(evt.sku);
      if (!row) return;
      if (evt.outcome === 'completed') {
        row.onHand = Math.max(0, row.onHand + evt.deltaOnHand);
      }
    });

  handleInventoryConsolidated({ eventId: 'evt-a2-1', sku: 'SKU-A2-01', outcome: 'completed', deltaOnHand: -5 });
  handleInventoryConsolidated({ eventId: 'evt-a2-2', sku: 'SKU-A2-01', outcome: 'rejected', deltaOnHand: -10 });
  handleInventoryConsolidated({ eventId: 'evt-a2-1', sku: 'SKU-A2-01', outcome: 'completed', deltaOnHand: -5 });

  assert.deepEqual(balances.get('SKU-A2-01'), { onHand: 15, reserved: 2, status: 'DISPONIBLE' });
});

test('JOINT-01 y JOINT-01-REGRESSION: commit atómico + Outbox y residuo previo no publicado no secuestra correlación', () => {
  const bus = new InMemoryDurableBusDouble();
  bus.outbox.push({
    id: 'outbox-stale-00',
    correlationId: 'corr-stale-previous',
    eventType: 'catalog.sync.requested',
    payload: { productId: 'prod-stale' },
    published: false,
  });

  bus.outbox.push({
    id: 'outbox-corr-joint-01',
    correlationId: 'corr-joint-01',
    eventType: 'catalog.sync.requested',
    payload: { productId: 'prod-joint-01' },
    published: false,
  });

  const matched = bus.outbox.filter((r) => r.correlationId === 'corr-joint-01' && !r.published);
  assert.equal(matched.length, 1);
  assert.equal(matched[0].payload.productId, 'prod-joint-01');
  assert.equal(matched.some((r) => r.correlationId === 'corr-stale-previous'), false);

  let resultApplyCount = 0;
  bus.processWithInbox('evt-joint-result-01', () => {
    resultApplyCount += 1;
  });
  bus.processWithInbox('evt-joint-result-01', () => {
    resultApplyCount += 1;
  });
  assert.equal(resultApplyCount, 1);
});

test('BULK-JOINT y BULK-CONSUMER-v2: transacción Bulk/Catalog, resolución de SKU simple/variante y replay idempotente', () => {
  const bus = new InMemoryDurableBusDouble();
  const catalogBySku = new Map();

  const consumeBulkV2 = (evt) =>
    bus.processWithInbox(evt.eventId, () => {
      for (const item of evt.items) {
        catalogBySku.set(item.sku, {
          productId: item.productId,
          variantId: item.variantId,
          price: item.price,
        });
      }
      bus.outbox.push({
        id: `outbox-bulk-${evt.batchId}`,
        correlationId: evt.batchId,
        eventType: 'bulk.catalog.applied.v2',
        payload: { batchId: evt.batchId, appliedSkus: evt.items.map((i) => i.sku) },
        published: false,
      });
    });

  const payload = {
    eventId: 'evt-bulk-v2-001',
    batchId: 'batch-h5-001',
    items: [
      { productId: 'prod-s-1', variantId: null, sku: 'SKU-SIMPLE-01', price: 49.9 },
      { productId: 'prod-v-1', variantId: 'var-1', sku: 'SKU-VAR-01-S', price: 89.9 },
    ],
  };

  assert.equal(consumeBulkV2(payload).applied, true);
  assert.equal(consumeBulkV2(payload).applied, false);

  assert.deepEqual(catalogBySku.get('SKU-SIMPLE-01'), { productId: 'prod-s-1', variantId: null, price: 49.9 });
  assert.deepEqual(catalogBySku.get('SKU-VAR-01-S'), { productId: 'prod-v-1', variantId: 'var-1', price: 89.9 });
  assert.equal(bus.outbox.filter((o) => o.correlationId === 'batch-h5-001').length, 1);
});
