import { randomUUID } from 'node:crypto';
import { ManagedIdentityCredential } from '@azure/identity';
import { ServiceBusClient } from '@azure/service-bus';
import { Pool, type PoolClient } from 'pg';
import { CombosEventConsumer } from '../src/messaging/combos-event-consumer.js';
import type { CombosDatabase } from '../src/persistence/combos.database.js';
import { CombosRepository } from '../src/persistence/combos.repository.js';

const realAzureEnabled =
  process.env.G6_H5_COMBOS_REAL_AZURE === '1' &&
  Boolean(process.env.G6_H5_COMBOS_PG_URL);

describe.skipIf(!realAzureEnabled)(
  'Combos H5 Azure Service Bus opt-in E2E (requires real Azure namespace + Managed Identity)',
  () => {
    it('receives R05/R12 messages with peekLock and persists once in combos.inbox', async () => {
      const ns = process.env.G6_H5_LAB_NAMESPACE_FQDN ?? '';
      const combosClientId = process.env.G6_H5_LAB_COMBOS_CLIENT_ID ?? '';
      const senderClientId = process.env.G6_H5_LAB_SENDER_CLIENT_ID ?? '';
      if (
        !/^[a-z][a-z0-9-]{4,48}[a-z0-9]\.servicebus\.windows\.net$/.test(ns) ||
        !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(combosClientId) ||
        !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(senderClientId)
      ) {
        throw new Error(
          'G6_H5_LAB_NAMESPACE_FQDN, G6_H5_LAB_COMBOS_CLIENT_ID and G6_H5_LAB_SENDER_CLIENT_ID are required',
        );
      }

      const pool = new Pool({
        connectionString: process.env.G6_H5_COMBOS_PG_URL,
        connectionTimeoutMillis: 3000,
      });
      const db = {
        query: async <T>(work: (client: PoolClient) => Promise<T>) => {
          const client = await pool.connect();
          try {
            return await work(client);
          } finally {
            client.release();
          }
        },
      } as CombosDatabase;
      const consumer = new CombosEventConsumer(new CombosRepository(db));
      const senderBus = new ServiceBusClient(
        ns,
        new ManagedIdentityCredential({ clientId: senderClientId }),
      );
      const receiverBus = new ServiceBusClient(
        ns,
        new ManagedIdentityCredential({ clientId: combosClientId }),
      );
      const sender = senderBus.createSender('g6.combos.from.catalog');
      const receiver = receiverBus.createReceiver('g6.combos.from.catalog', {
        receiveMode: 'peekLock',
        skipParsingBodyAsJson: true,
      });

      try {
        const messageId = randomUUID();
        const correlationId = randomUUID();
        const sku = `H5-AZURE-${randomUUID().slice(0, 8)}`;
        const envelope = {
          message_id: messageId,
          schema_version: 1,
          occurred_at: new Date().toISOString(),
          correlation_id: correlationId,
          causation_id: null,
          operation_id: null,
          producer: 'catalog-svc',
          kind: 'event',
          name: 'catalog.sku.deactivated',
          data: {
            sku,
            product_id: randomUUID(),
            sku_version: 1,
            changed_at: new Date().toISOString(),
          },
        };
        await sender.sendMessages({
          body: Buffer.from(JSON.stringify(envelope), 'utf8'),
          messageId,
          correlationId,
          subject: 'catalog.sku.deactivated',
          contentType: 'application/json',
          applicationProperties: {
            producer: 'catalog-svc',
            schema_version: 1,
            route_version: 1,
          },
        });
        const [delivery] = await receiver.receiveMessages(1, {
          maxWaitTimeInMs: 12_000,
        });
        expect(delivery?.messageId).toBe(messageId);
        await consumer.processServiceBusDelivery(
          'g6.combos.from.catalog',
          receiver,
          delivery!,
        );
        const inbox = await pool.query(
          'SELECT result FROM combos.inbox WHERE message_id = $1',
          [messageId],
        );
        expect(inbox.rows).toEqual([{ result: 'PROCESSED' }]);
      } finally {
        await Promise.allSettled([
          sender.close(),
          receiver.close(),
          senderBus.close(),
          receiverBus.close(),
          pool.end(),
        ]);
      }
    }, 60_000);
  },
);
