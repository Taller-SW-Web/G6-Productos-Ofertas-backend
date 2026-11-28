import { describe, expect, it } from 'vitest';
import {
  BulkPersistenceRepository,
  type CreateImportBatchInput,
} from './bulk.repository.js';

describe('intención durable obligatoria antes de admisión Bulk', () => {
  const rowId = '11111111-1111-4111-8111-111111111111';
  const input: CreateImportBatchInput = {
    batchId: rowId,
    ownerSub: rowId,
    correlationId: rowId,
    templateVersion: 2,
    inputFile: { format: 'CSV', contentRef: 'test://isolated' },
    rows: [{ rowId, requiredDomains: ['CATALOGO'] }],
    admissionIntent: { rows: [{ rowId }] },
  };
  it.each([undefined, null, {}, { rows: [] }, { rows: [{ rowId: 'other' }] }])(
    'rechaza intención incompleta %j antes de acceder a DB u outbox',
    async (intent) => {
      const repository = new BulkPersistenceRepository(null);
      // Reflect represents untyped callers without weakening the production type.
      const candidate = { ...input };
      Reflect.set(candidate, 'admissionIntent', intent);
      await expect(
        repository.createImportBatch(candidate),
      ).rejects.toMatchObject({ code: 'CHECK_VIOLATION' });
    },
  );
});
