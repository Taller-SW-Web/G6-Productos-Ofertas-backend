import { describe, expect, it } from 'vitest';
import { parseChecked } from '../persistence/taxonomy-message.store.js';
import { evaluarCheckBaja } from './deactivation-check.js';

// AsyncAPI CatalogMasterDeactivationChecked: operation_id es obligatorio para
// este mensaje, aunque el sobre genérico permita omitirlo. El fork de Axel
// 22667994b970d1ee4b4afdb462797c3cb0a8f43e acepta causation_id nulo/ausente.
const mensaje = {
  message_id: '11111111-1111-4111-8111-111111111111',
  correlation_id: '22222222-2222-4222-8222-222222222222',
  operation_id: '33333333-3333-4333-8333-333333333333',
  schema_version: 1,
  occurred_at: '2026-11-20T00:00:00Z',
  producer: 'catalog-svc',
  kind: 'result',
  name: 'catalog.master.deactivation.checked',
  data: {
    entity_type: 'BRAND',
    entity_id: '44444444-4444-4444-8444-444444444444',
    version: 1,
    result: 'CLEAR',
  },
};

describe('Compatibilidad contractual de resultados de baja', () => {
  it.each([undefined, null, 'causa-valida'])(
    'acepta causation_id opcional: %s',
    (causationId) => {
      const sobre =
        causationId === undefined
          ? mensaje
          : { ...mensaje, causation_id: causationId };
      expect(parseChecked(sobre).causation_id).toBe(causationId);
    },
  );

  it.each([undefined, null, 'invalido'])(
    'exige operation_id UUID para el resultado específico: %s',
    (operationId) => {
      expect(() =>
        parseChecked({ ...mensaje, operation_id: operationId }),
      ).toThrow('INVALID_ENVELOPE');
    },
  );

  it('rechaza causation_id de tipo inválido', () => {
    expect(() => parseChecked({ ...mensaje, causation_id: 123 })).toThrow(
      'INVALID_ENVELOPE',
    );
  });

  it.each([
    ['CLEAR', 'EVALUAR_BAJA'],
    ['IN_USE', 'RECHAZAR_BAJA'],
  ] as const)('correlaciona %s como %s', (result, esperado) => {
    const checked = parseChecked({
      ...mensaje,
      causation_id: null,
      data: { ...mensaje.data, result },
    });
    const identidad = {
      operationId: checked.operation_id,
      correlationId: checked.correlation_id,
      entityType: checked.data.entity_type,
      entityId: checked.data.entity_id,
      version: checked.data.version,
    };
    expect(evaluarCheckBaja(identidad, { ...identidad, result })).toBe(
      esperado,
    );
  });
});
