import { randomUUID } from 'node:crypto';
import {
  activeAttempt,
  envelope,
  InvalidCatalogMessage,
  manualRetryAllowed,
  parseCatalogMessage,
  preparationTimeout,
} from './catalog-messages.js';

describe('Catalog preparation message contract and retry identity', () => {
  const result = () => ({
    message_id: randomUUID(),
    schema_version: 1,
    occurred_at: new Date().toISOString(),
    correlation_id: randomUUID(),
    operation_id: randomUUID(),
    causation_id: randomUUID(),
    producer: 'inventory-svc',
    kind: 'result',
    name: 'inventory.sku.initialization.completed',
    data: {
      product_id: randomUUID(),
      sku: '0000123',
      variant_id: null,
      status: 'INITIALIZED',
      completed_at: new Date().toISOString(),
    },
  });
  it('validates typed results and preserves SKU identity', () => {
    expect(parseCatalogMessage(result()).data.sku).toBe('0000123');
  });
  it.each([
    { schema_version: 2 },
    { producer: 'pricing-svc' },
    { operation_id: null },
    { causation_id: null },
    { kind: 'event' },
    {
      data: {
        product_id: 'p',
        sku: '000',
        status: 'READY',
        completed_at: 'bad-time',
      },
    },
  ])('rejects invalid result envelope or payload %j', (patch) => {
    expect(() => parseCatalogMessage({ ...result(), ...patch })).toThrow(
      InvalidCatalogMessage,
    );
  });
  it('accepts business rejection as a typed result, without interpreting it as a technical error', () => {
    const message = result();
    message.name = 'inventory.sku.initialization.rejected';
    message.data.status = 'REJECTED';
    expect(parseCatalogMessage(message).data.status).toBe('REJECTED');
  });
  it('reconstructs the unique active attempt from persisted causal links regardless of row order', () => {
    const first = {
      message_id: randomUUID(),
      causation_id: null,
      published_at: new Date(0),
      occurred_at: new Date(0),
    };
    const second = {
      ...first,
      message_id: randomUUID(),
      causation_id: first.message_id,
      published_at: null,
    };
    expect(activeAttempt([second, first])).toBe(second);
    expect(manualRetryAllowed('PENDING', second, 1, 100)).toBe(false);
    expect(manualRetryAllowed('PENDING', first, 50, 100)).toBe(true);
    expect(manualRetryAllowed('COMPLETED', first, 1, 100)).toBe(false);
    expect(manualRetryAllowed('REJECTED', first, 1, 100)).toBe(false);
  });
  it('fails closed on branched, missing or cyclic attempt history', () => {
    const first = {
      message_id: 'a',
      causation_id: null,
      published_at: null,
      occurred_at: new Date(),
    };
    const child = { ...first, message_id: 'b', causation_id: 'a' };
    expect(() =>
      activeAttempt([first, child, { ...child, message_id: 'c' }]),
    ).toThrow();
    expect(() =>
      activeAttempt([first, { ...child, causation_id: 'missing' }]),
    ).toThrow();
    expect(() =>
      activeAttempt([{ ...first, causation_id: 'b' }, child]),
    ).toThrow();
  });
  it('does not invent an operational timeout or a reactivation event', () => {
    expect(preparationTimeout({})).toBeUndefined();
    expect(() =>
      preparationTimeout({ CATALOG_PREPARATION_TIMEOUT_MS: '-1' }),
    ).toThrow();
    expect(() =>
      envelope('catalog.product.reactivated', {}, randomUUID()),
    ).toThrow();
  });
});
