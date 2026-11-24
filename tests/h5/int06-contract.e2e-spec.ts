import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadR18Contract } from './int06-asyncapi.mjs';
import { parseChecked } from '../../apps/taxonomy-svc/src/persistence/taxonomy-message.store.js';
import { evaluarCheckBaja } from '../../apps/taxonomy-svc/src/domain/deactivation-check.js';

const configuredDocs = process.env.G6_E2E_DOCS_PATH?.trim();
const defaultDocs = resolve('../G6-Productos-Ofertas-docs');
const docs =
  configuredDocs ||
  (existsSync(join(defaultDocs, 'contratos/eventos/asyncapi.yaml'))
    ? defaultDocs
    : undefined);

describe.skipIf(!docs)('INT-06 AsyncAPI rc.3 — R09/R18 contractual', () => {
  it('validates six R18 events against the official contract', async () => {
    const schemas = await loadR18Contract(docs);
    for (const name of [
      'taxonomy.category.updated',
      'taxonomy.product-type-schema.changed',
      'taxonomy.characteristic-value.updated',
      'taxonomy.master.deactivation.check.requested',
      'taxonomy.master.deactivated',
      'taxonomy.master.deactivation.rejected',
    ]) {
      const kind = name.endsWith('.requested')
        ? 'command'
        : name.endsWith('.rejected')
          ? 'result'
          : 'event';
      const data = name.startsWith('taxonomy.master.')
        ? {
            entity_type: 'CATEGORY',
            entity_id: randomUUID(),
            version: 0,
            ...(kind === 'result' ? { reason: 'IN_USE' } : {}),
          }
        : { entity_id: randomUUID(), version: 1 };
      const message = {
        message_id: randomUUID(),
        correlation_id: randomUUID(),
        operation_id: randomUUID(),
        schema_version: 1,
        occurred_at: '2026-11-24T00:00:00Z',
        producer: 'taxonomy-svc',
        kind,
        name,
        data,
      };
      const validate = schemas.get(name);
      expect(validate).toBeDefined();
      expect(() => validate(message)).not.toThrow();
      if (!name.startsWith('taxonomy.master.')) {
        const { operation_id: _optionalOperation, ...withoutOperation } =
          message;
        expect(() => validate(withoutOperation)).not.toThrow();
        expect(() =>
          validate({ ...message, operation_id: null }),
        ).not.toThrow();
      }
      expect(() => validate({ ...message, producer: 'catalog-svc' })).toThrow();
      expect(Buffer.byteLength(JSON.stringify(message))).toBeLessThan(
        256 * 1024,
      );
    }
  });
  it.each(['CATEGORY', 'BRAND'] as const)(
    'correlates %s CLEAR and IN_USE and ignores stale/foreign results',
    async (entityType) => {
      const validate = (await loadR18Contract(docs)).get(
        'catalog.master.deactivation.checked',
      );
      const message = {
        message_id: randomUUID(),
        correlation_id: randomUUID(),
        operation_id: randomUUID(),
        schema_version: 1,
        occurred_at: '2026-11-24T00:00:00Z',
        producer: 'catalog-svc',
        kind: 'result',
        name: 'catalog.master.deactivation.checked',
        data: {
          entity_type: entityType,
          entity_id: randomUUID(),
          version: 4,
          result: 'CLEAR',
        },
      };
      const identity = {
        operationId: message.operation_id,
        correlationId: message.correlation_id,
        entityType,
        entityId: message.data.entity_id,
        version: 4,
      };
      for (const result of ['CLEAR', 'IN_USE'] as const)
        for (const causation_id of [undefined, null, randomUUID()]) {
          const candidate = {
            ...message,
            ...(causation_id === undefined ? {} : { causation_id }),
            data: { ...message.data, result },
          };
          expect(() => validate(candidate)).not.toThrow();
          const checked = parseChecked(candidate);
          expect(
            evaluarCheckBaja(identity, {
              ...identity,
              result: checked.data.result,
            }),
          ).toBe(result === 'CLEAR' ? 'EVALUAR_BAJA' : 'RECHAZAR_BAJA');
        }
      expect(() =>
        parseChecked({ ...message, operation_id: 'invalid' }),
      ).toThrow('INVALID_ENVELOPE');
      expect(() => parseChecked({ ...message, operation_id: null })).toThrow(
        'INVALID_ENVELOPE',
      );
      expect(() => validate({ ...message, operation_id: null })).toThrow();
      expect(
        evaluarCheckBaja(identity, {
          ...identity,
          version: 3,
          result: 'CLEAR',
        }),
      ).toBe('IGNORAR');
      expect(
        evaluarCheckBaja(identity, {
          ...identity,
          operationId: randomUUID(),
          result: 'CLEAR',
        }),
      ).toBe('IGNORAR');
    },
  );
});
