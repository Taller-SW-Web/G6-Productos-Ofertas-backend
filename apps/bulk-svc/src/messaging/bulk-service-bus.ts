import { ManagedIdentityCredential } from '@azure/identity';
import {
  ServiceBusClient,
  type ServiceBusReceivedMessage,
} from '@azure/service-bus';
import type { CatalogBulkResultConsumer } from './catalog-bulk-result-consumer.js';

export const BULK_TO_CATALOG_QUEUE = 'g6.catalog.from.bulk';
export const CATALOG_TO_BULK_QUEUE = 'g6.bulk.from.catalog';
export const SERVICE_BUS_MAX_MESSAGE_BYTES = 256 * 1024;

type ServiceBusClientLike = Pick<
  ServiceBusClient,
  'createSender' | 'createReceiver' | 'close'
>;

function decodeEnvelopeBody(body: unknown): Uint8Array | undefined {
  if (body instanceof Uint8Array) return body;
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  return undefined;
}

export class BulkServiceBus {
  constructor(private readonly client: ServiceBusClientLike) {}

  async publishCatalogCommand(
    input: {
      messageId: string;
      correlationId: string;
      eventName: string;
      payload: Record<string, unknown>;
    },
    abortSignal?: AbortSignal,
  ): Promise<void> {
    const sender = this.client.createSender(BULK_TO_CATALOG_QUEUE);
    const batch = await sender.createMessageBatch({
      maxSizeInBytes: SERVICE_BUS_MAX_MESSAGE_BYTES,
      abortSignal,
    });
    const added = batch.tryAddMessage({
      body: Buffer.from(JSON.stringify(input.payload), 'utf8'),
      contentType: 'application/json',
      messageId: input.messageId,
      correlationId: input.correlationId,
      subject: input.eventName,
    });
    if (!added) throw new Error('SERVICE_BUS_MESSAGE_TOO_LARGE');
    await sender.sendMessages(batch, { abortSignal });
  }

  subscribeCatalogResults(
    consumer: Pick<CatalogBulkResultConsumer, 'consumeServiceBusMessage'>,
    reportError: () => void,
  ) {
    const receiver = this.client.createReceiver(CATALOG_TO_BULK_QUEUE, {
      receiveMode: 'peekLock',
      skipParsingBodyAsJson: true,
    });
    const subscription = receiver.subscribe(
      {
        processMessage: async (received: ServiceBusReceivedMessage) => {
          const body = decodeEnvelopeBody(received.body);
          try {
            if (!body || body.byteLength > SERVICE_BUS_MAX_MESSAGE_BYTES)
              throw new Error('INVALID_SERVICE_BUS_CATALOG_RESULT');
            if (typeof received.messageId !== 'string' || !received.messageId)
              throw new Error('INVALID_SERVICE_BUS_MESSAGE_ID');
            await consumer.consumeServiceBusMessage({
              messageId: received.messageId,
              correlationId:
                typeof received.correlationId === 'string'
                  ? received.correlationId
                  : undefined,
              subject: received.subject,
              contentType: received.contentType,
              body,
            });
          } catch {
            reportError();
            await receiver.abandonMessage(received);
            return;
          }
          // Catalog Inbox/Outbox persistence completed before settlement.
          await receiver.completeMessage(received);
        },
        processError: async () => reportError(),
      },
      { autoCompleteMessages: false },
    );
    return {
      probe: (abortSignal: AbortSignal) =>
        receiver.peekMessages(1, { abortSignal }),
      close: async () => {
        try {
          await subscription.close();
        } finally {
          await receiver.close();
        }
      },
    };
  }

  async verifySender(abortSignal: AbortSignal): Promise<void> {
    const sender = this.client.createSender(BULK_TO_CATALOG_QUEUE);
    await sender.createMessageBatch({
      maxSizeInBytes: SERVICE_BUS_MAX_MESSAGE_BYTES,
      abortSignal,
    });
  }

  close(): Promise<void> {
    return this.client.close();
  }
}

export function createBulkServiceBus(
  env: NodeJS.ProcessEnv,
): BulkServiceBus | undefined {
  const provider = env.MESSAGING_PROVIDER ?? 'RABBITMQ';
  if (provider === 'RABBITMQ') return undefined;
  if (provider !== 'AZURE_SERVICE_BUS')
    throw new Error(
      'MESSAGING_PROVIDER debe ser RABBITMQ o AZURE_SERVICE_BUS.',
    );
  if (env.BULK_AMQP_ENABLED === 'true')
    throw new Error('Bulk no permite AMQP y Service Bus en el mismo proceso.');

  const clientId = env.AZURE_CLIENT_ID;
  const validIdentity =
    clientId &&
    /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(clientId) &&
    clientId !== '00000000-0000-0000-0000-000000000000';
  if (
    (clientId !== undefined && !validIdentity) ||
    (env.NODE_ENV === 'production' &&
      (!validIdentity ||
        env.G6_SECURITY_MODE !== 'G7_AUTHENTICATED' ||
        env.G6_SERVICE_BUS_PRODUCTION_ENABLED !== 'true'))
  )
    throw new Error(
      'H5 en producción requiere habilitación, G7 e identidad administrada asignada.',
    );

  const namespace = env.SERVICE_BUS_NAMESPACE_FQDN;
  if (
    !namespace ||
    !/^[a-z][a-z0-9-]{4,48}[a-z0-9]\.servicebus\.windows\.net$/i.test(namespace)
  )
    throw new Error('SERVICE_BUS_NAMESPACE_FQDN inválido.');
  const client = new ServiceBusClient(
    namespace,
    clientId
      ? new ManagedIdentityCredential({ clientId })
      : new ManagedIdentityCredential(),
    { retryOptions: { maxRetries: 0, timeoutInMs: 5000 } },
  );
  return new BulkServiceBus(client);
}
