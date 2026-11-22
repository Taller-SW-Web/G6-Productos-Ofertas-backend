import { randomUUID } from 'node:crypto';
import type { ConsumeMessage } from 'amqplib';
import { validateEnvelope } from './catalog-bulk-result-consumer.js';

describe('Catalog Bulk result envelope V2', () => {
  function result() {
    const messageId = randomUUID();
    const correlationId = randomUUID();
    const operationId = randomUUID();
    const envelope = {
      message_id: messageId,
      schema_version: 2,
      occurred_at: new Date().toISOString(),
      correlation_id: correlationId,
      causation_id: randomUUID(),
      operation_id: operationId,
      producer: 'catalog-svc',
      kind: 'result',
      name: 'catalog.bulk.upsert.completed',
      data: {
        batch_id: randomUUID(),
        batch_operation_id: operationId,
        command_attempt_id: randomUUID(),
        results: [
          {
            row_number: 2,
            row_operation_id: randomUUID(),
            product_id: randomUUID(),
            sku_base: 'SKU-1',
            status: 'COMPLETED',
            code: null,
            attempt_id: randomUUID(),
            attempt_number: 2,
            effect_state: 'APPLIED',
            retriable: false,
          },
        ],
      },
    };
    const transport = {
      properties: {
        messageId,
        type: envelope.name,
        contentType: 'application/json',
      },
      fields: { routingKey: envelope.name },
    } as ConsumeMessage;
    return { envelope, transport };
  }

  it('accepts complete per-row attempt receipts and a retry command identity', () => {
    const { envelope, transport } = result();
    expect(validateEnvelope(envelope, transport)).toEqual(envelope);
  });

  it.each([
    { attempt_number: 0 },
    { attempt_id: 'not-a-uuid' },
    { effect_state: 'APPLIED', retriable: true },
    {
      status: 'REJECTED',
      code: 'OTHER',
      effect_state: 'NONE',
      retriable: true,
    },
    { command_attempt_id: 'not-a-uuid' },
  ])('rejects inconsistent V2 metadata %#', (change) => {
    const { envelope, transport } = result();
    const invalid = structuredClone(envelope);
    Object.assign(invalid.data.results[0]!, change);
    if ('command_attempt_id' in change)
      Object.assign(invalid.data, {
        command_attempt_id: change.command_attempt_id,
      });
    expect(() => validateEnvelope(invalid, transport)).toThrow(
      'INVALID_PAYLOAD',
    );
  });
});
