import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DefaultAzureCredential } from '@azure/identity';
import { ServiceBusClient } from '@azure/service-bus';
import {
  buildCatalogBulkCommands,
  type CatalogBulkRow,
} from '../src/messaging/catalog-bulk-upsert.js';
import { BULK_TO_CATALOG_QUEUE, SERVICE_BUS_MAX_MESSAGE_BYTES } from '../src/messaging/bulk-service-bus.js';

const fixtureRoot = resolve('apps/bulk-svc/test/fixtures/h5-claim-check');
const row: CatalogBulkRow = {
  row_number: 1,
  row_operation_id: randomUUID(),
  producto_id: null,
  sku_base: 'H5-CLAIM-CHECK-001',
  product: {},
  variant_id: null,
  variant: null,
};

describe('INT-04-R01-R04 claim-check contract preflight (no network or broker)', () => {
  it.each([255, 257])('keeps %i KiB content outside the Basic envelope', async (kib) => {
    const bytes = readFileSync(resolve(fixtureRoot, `claim-check-${kib}kib.json`));
    expect(bytes.byteLength).toBe(kib * 1024);
    const reference = {
      content_id: randomUUID(),
      sha256: createHash('sha256').update(bytes).digest('hex'),
      byte_length: bytes.length,
      content_type: 'application/json' as const,
    };
    const command = buildCatalogBulkCommands({
      batchId: randomUUID(),
      correlationId: randomUUID(),
      rows: [row],
      schemaVersion: 3,
      contentReference: reference,
      occurredAt: new Date('2026-01-01T00:00:00.000Z'),
    })[0]!;
    const serializedBytes = Buffer.byteLength(command.serialized, 'utf8');
    expect(command.envelope.data.content_ref).toEqual(reference);
    expect(command.envelope.data).not.toHaveProperty('rows');
    expect(serializedBytes).toBeLessThanOrEqual(SERVICE_BUS_MAX_MESSAGE_BYTES);
    expect(bytes.length).not.toBe(serializedBytes);
    const client = new ServiceBusClient('h5-fixture.servicebus.windows.net', new DefaultAzureCredential());
    try {
      const batch = await client.createSender(BULK_TO_CATALOG_QUEUE).createMessageBatch({ maxSizeInBytes: SERVICE_BUS_MAX_MESSAGE_BYTES });
      expect(batch.tryAddMessage({ body: Buffer.from(command.serialized), contentType: 'application/json', messageId: command.envelope.message_id, correlationId: command.envelope.correlation_id, subject: command.envelope.name })).toBe(true);
    } finally { await client.close(); }
  });

  it('rejects uppercase/tampered digest metadata before creating a command', () => {
    expect(() => buildCatalogBulkCommands({
      batchId: randomUUID(), correlationId: randomUUID(), rows: [row], schemaVersion: 3,
      contentReference: { content_id: randomUUID(), sha256: 'A'.repeat(64), byte_length: 1, content_type: 'application/json' },
    })).toThrow(/content_ref/);
  });

  it('finds the SDK batch boundary with metadata included, without sending it', async () => {
    const client = new ServiceBusClient('h5-fixture.servicebus.windows.net', new DefaultAzureCredential());
    const sender = client.createSender(BULK_TO_CATALOG_QUEUE);
    const makeBatch = () => sender.createMessageBatch({ maxSizeInBytes: SERVICE_BUS_MAX_MESSAGE_BYTES });
    const message = (size: number) => ({ body: Buffer.alloc(size, 0x61), contentType: 'application/json', messageId: 'h5-boundary-message', correlationId: 'h5-boundary-correlation', subject: 'catalog.bulk.upsert.requested' });
    try {
      let lower = 0; let upper = SERVICE_BUS_MAX_MESSAGE_BYTES;
      while (lower < upper) {
        const candidate = Math.ceil((lower + upper) / 2);
        const batch = await makeBatch();
        if (batch.tryAddMessage(message(candidate))) lower = candidate;
        else upper = candidate - 1;
      }
      const atBoundary = await makeBatch();
      expect(atBoundary.tryAddMessage(message(lower))).toBe(true);
      const overBoundary = await makeBatch();
      expect(overBoundary.tryAddMessage(message(lower + 1))).toBe(false);
      expect(atBoundary.sizeInBytes).toBeLessThanOrEqual(SERVICE_BUS_MAX_MESSAGE_BYTES);
    } finally { await client.close(); }
  });
});
