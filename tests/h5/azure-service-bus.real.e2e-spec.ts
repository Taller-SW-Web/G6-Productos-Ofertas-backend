import { randomUUID } from 'node:crypto';
import { ServiceBusClient } from '@azure/service-bus';
import { ManagedIdentityCredential } from '@azure/identity';
import { describe, expect, it } from 'vitest';

const EXPECTED_19_QUEUES = [
  'g6.price-audit.from.pricing',
  'g6.catalog.from.taxonomy',
  'g6.catalog.from.bulk',
  'g6.catalog.from.pricing',
  'g6.catalog.from.inventory',
  'g6.bulk.from.catalog',
  'g6.bulk.from.inventory',
  'g6.bulk.from.pricing',
  'g6.pricing.from.catalog',
  'g6.pricing.from.bulk',
  'g6.inventory.from.catalog',
  'g6.inventory.from.bulk',
  'g6.promotions.from.catalog',
  'g6.promotions.from.pricing',
  'g6.promotions.from.inventory',
  'g6.combos.from.catalog',
  'g6.combos.from.inventory',
  'g6.taxonomy.from.catalog',
  'g6.promotions.commands',
] as const;

const LAB_FQDN = process.env.G6_AZURE_SERVICE_BUS_LAB_NAMESPACE ?? '';
const CLIENT_ID = process.env.AZURE_CLIENT_ID ?? '';
const REAL_SB_ENABLED =
  process.env.G6_AZURE_SERVICE_BUS_REAL_TESTS === '1' &&
  Boolean(LAB_FQDN) &&
  Boolean(CLIENT_ID);

describe.skipIf(!REAL_SB_ENABLED)(
  'Azure Service Bus Basic generic lab SDK transport probe across 19 queues (ManagedIdentityCredential, not business E2E, ESCRITA_NO_EJECUTADA)',
  () => {
    it.each(EXPECTED_19_QUEUES)(
      'sends, receives in peekLock, completes and isolates fixture on lab queue %s',
      async (queueName) => {
        if (!/^[a-z][a-z0-9-]{4,48}[a-z0-9]\.servicebus\.windows\.net$/.test(LAB_FQDN)) {
          throw new Error('Invalid G6_AZURE_SERVICE_BUS_LAB_NAMESPACE');
        }
        if (!/(lab|test|dev)/i.test(LAB_FQDN)) {
          throw new Error('Refusing to run real Service Bus suite against non-lab namespace');
        }
        if (!EXPECTED_19_QUEUES.includes(queueName)) {
          throw new Error(`Queue ${queueName} is not in the 19-queue allowlist`);
        }

        const credential = new ManagedIdentityCredential({ clientId: CLIENT_ID });
        const client = new ServiceBusClient(LAB_FQDN, credential);
        const sender = client.createSender(queueName);
        const receiver = client.createReceiver(queueName, {
          receiveMode: 'peekLock',
        });

        const messageId = randomUUID();
        const correlationId = randomUUID();
        try {
          await sender.sendMessages({
            messageId,
            correlationId,
            subject: 'g6.lab.probe',
            contentType: 'application/json',
            timeToLive: 60_000,
            body: {
              message_id: messageId,
              correlation_id: correlationId,
              name: 'g6.lab.probe',
              test_fixture: true,
            },
          });

          const messages = await receiver.receiveMessages(10, {
            maxWaitTimeInMs: 10_000,
          });
          const match = messages.find((m) => m.messageId === messageId);
          expect(match).toBeDefined();
          if (match) {
            await receiver.completeMessage(match);
          }
          for (const other of messages) {
            if (other.messageId !== messageId) {
              await receiver.abandonMessage(other);
            }
          }
        } finally {
          await sender.close();
          await receiver.close();
          await client.close();
        }
      },
      30_000,
    );
  },
);
