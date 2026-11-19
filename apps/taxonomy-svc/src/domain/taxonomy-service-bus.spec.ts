import { describe, expect, it, vi } from 'vitest';
import type { ServiceBusReceivedMessage } from '@azure/service-bus';
import {
  leerServiceBus,
  TaxonomyServiceBusBridge,
  verificarPersistenciaServiceBus,
} from './taxonomy-service-bus.js';
import type { Database } from '../database.js';

const id = '11111111-1111-4111-8111-111111111111';
const correlation = '22222222-2222-4222-8222-222222222222';
const operation = '33333333-3333-4333-8333-333333333333';
const response = {
  message_id: id,
  correlation_id: correlation,
  operation_id: operation,
  schema_version: 1,
  occurred_at: '2026-11-02T00:00:00Z',
  producer: 'catalog-svc',
  kind: 'result',
  name: 'catalog.master.deactivation.checked',
  data: {
    entity_type: 'BRAND',
    entity_id: '55555555-5555-4555-8555-555555555555',
    version: 0,
    result: 'CLEAR',
  },
};
function delivery(body: unknown = response): ServiceBusReceivedMessage {
  return {
    body: Buffer.from(JSON.stringify(body)),
    contentType: 'application/json',
    messageId: id,
    correlationId: correlation,
    subject: response.name,
  } as ServiceBusReceivedMessage;
}
function fixture() {
  const add = vi.fn().mockReturnValue(true);
  const sender = {
    createMessageBatch: vi.fn().mockResolvedValue({ tryAddMessage: add }),
    sendMessages: vi.fn().mockResolvedValue(undefined),
  };
  const receiver = {
    completeMessage: vi.fn().mockResolvedValue(undefined),
    abandonMessage: vi.fn().mockResolvedValue(undefined),
    deadLetterMessage: vi.fn().mockResolvedValue(undefined),
  };
  const store = {
    consumir: vi.fn().mockResolvedValue(undefined),
    publicarUnoServiceBus: vi.fn().mockResolvedValue('VACIO'),
  };
  const bridge = new TaxonomyServiceBusBridge(
    store,
    sender as unknown as ConstructorParameters<
      typeof TaxonomyServiceBusBridge
    >[1],
    receiver,
  );
  return { bridge, store, sender, receiver, add };
}
describe('Taxonomy Service Bus', () => {
  it('no habilita H5 sin migración, trigger y permisos verificados', async () => {
    const fake = (ready: boolean) =>
      ({
        read: (
          query: (db: {
            execute: () => Promise<{ rows: Array<{ ready: boolean }> }>;
          }) => unknown,
        ) => query({ execute: async () => ({ rows: [{ ready }] }) }),
      }) as unknown as Database;
    await expect(verificarPersistenciaServiceBus(fake(false))).rejects.toThrow(
      'TAXONOMY_SERVICE_BUS_STORAGE_NOT_READY',
    );
    await expect(
      verificarPersistenciaServiceBus(fake(true)),
    ).resolves.toBeUndefined();
  });
  it('requiere selección explícita, namespace e identidad válida y excluye AMQP', () => {
    expect(leerServiceBus({})).toBeUndefined();
    const env = {
      MESSAGING_PROVIDER: 'AZURE_SERVICE_BUS',
      TAXONOMY_SERVICE_BUS_ENABLED: 'true',
      NODE_ENV: 'test',
      SERVICE_BUS_NAMESPACE_FQDN: 'g6-sb-test-namespace.servicebus.windows.net',
    };
    expect(leerServiceBus(env)).toEqual({
      namespace: env.SERVICE_BUS_NAMESPACE_FQDN,
    });
    expect(() =>
      leerServiceBus({ ...env, RABBITMQ_URL: 'amqp://example' }),
    ).toThrow('TAXONOMY_MESSAGING_CONFIGURATION_INVALID');
    expect(() =>
      leerServiceBus({ ...env, SERVICE_BUS_NAMESPACE_FQDN: 'https://host' }),
    ).toThrow();
    expect(() =>
      leerServiceBus({ ...env, TAXONOMY_SERVICE_BUS_ENABLED: 'false' }),
    ).toThrow();
    expect(() => leerServiceBus({ ...env, NODE_ENV: 'production' })).toThrow();
    expect(() => leerServiceBus({ ...env, NODE_ENV: 'development' })).toThrow();
    expect(() =>
      leerServiceBus({
        ...env,
        SERVICE_BUS_NAMESPACE_FQDN: 'g6-shared.servicebus.windows.net',
      }),
    ).toThrow();
  });
  it.each([
    'taxonomy.category.updated',
    'taxonomy.product-type-schema.changed',
    'taxonomy.characteristic-value.updated',
    'taxonomy.master.deactivation.check.requested',
    'taxonomy.master.deactivated',
    'taxonomy.master.deactivation.rejected',
  ])('publica %s con identidad y correlación originales', async (name) => {
    const f = fixture();
    const kind = name.endsWith('.requested')
      ? 'command'
      : name.endsWith('.rejected')
        ? 'result'
        : 'event';
    const payload = {
      name,
      message_id: id,
      correlation_id: correlation,
      producer: 'taxonomy-svc',
      schema_version: 1,
      kind,
      data: {},
    };
    f.store.publicarUnoServiceBus.mockImplementation(async (publish) => {
      await publish({
        event_name: name,
        message_id: id,
        correlation_id: correlation,
        payload,
      });
      return 'PUBLICADO';
    });
    expect(await f.bridge.publicarUno()).toBe('PUBLICADO');
    expect(f.add).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: id,
        correlationId: correlation,
        subject: name,
        contentType: 'application/json',
        body: Buffer.from(JSON.stringify(payload)),
      }),
    );
    expect(f.sender.sendMessages).toHaveBeenCalledOnce();
  });
  it('no completa antes del commit y abandona cuando falla la persistencia', async () => {
    const f = fixture();
    f.store.consumir.mockRejectedValueOnce(new Error('DB'));
    await f.bridge.recibir(delivery());
    expect(f.receiver.abandonMessage).toHaveBeenCalledOnce();
    expect(f.receiver.completeMessage).not.toHaveBeenCalled();
    await f.bridge.recibir(delivery());
    expect(f.receiver.completeMessage).toHaveBeenCalledOnce();
  });
  it('permite redelivery tras fallo de confirmación sin volver a generar identidad', async () => {
    const f = fixture();
    f.receiver.completeMessage.mockRejectedValueOnce(new Error('link lost'));
    await expect(f.bridge.recibir(delivery())).rejects.toThrow('link lost');
    await f.bridge.recibir(delivery());
    expect(f.store.consumir).toHaveBeenCalledTimes(2);
    expect(f.store.consumir.mock.calls[0]?.[0]).toEqual(
      f.store.consumir.mock.calls[1]?.[0],
    );
  });
  it('envía a DLQ metadatos incorrectos sin aplicar la respuesta', async () => {
    const f = fixture();
    await f.bridge.recibir({ ...delivery(), correlationId: operation });
    expect(f.receiver.deadLetterMessage).toHaveBeenCalledOnce();
    expect(f.store.consumir).not.toHaveBeenCalled();
  });
  it('rechaza payload mayor al límite y no envía', async () => {
    const f = fixture();
    f.add.mockReturnValue(false);
    const name = 'taxonomy.category.updated';
    f.store.publicarUnoServiceBus.mockImplementation(async (publish) => {
      await publish({
        event_name: name,
        message_id: id,
        correlation_id: correlation,
        payload: {
          name,
          message_id: id,
          correlation_id: correlation,
          producer: 'taxonomy-svc',
          schema_version: 1,
          kind: 'event',
          data: {},
        },
      });
      return 'PUBLICADO';
    });
    await expect(f.bridge.publicarUno()).rejects.toThrow(
      'SERVICE_BUS_MESSAGE_TOO_LARGE',
    );
    expect(f.sender.sendMessages).not.toHaveBeenCalled();
  });
});
