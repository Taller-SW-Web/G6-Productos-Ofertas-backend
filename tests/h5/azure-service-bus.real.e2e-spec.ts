import { randomUUID } from 'node:crypto';
import { ServiceBusClient } from '@azure/service-bus';
import { DefaultAzureCredential } from '@azure/identity';
import { describe, expect, it } from 'vitest';

const REAL_SB_ENABLED =
  process.env.G6_AZURE_SERVICE_BUS_REAL_TESTS === '1' &&
  Boolean(process.env.SERVICE_BUS_NAMESPACE_FQDN);

describe.skipIf(!REAL_SB_ENABLED)(
  'Azure Service Bus Basic real SDK suite (Managed Identity, lab namespace only)',
  () => {
    it('sends, receives, completes and verifies 256 KB boundary on lab queue with Managed Identity', async () => {
      const fqdn = process.env.SERVICE_BUS_NAMESPACE_FQDN!;
      if (!/^[a-z][a-z0-9-]{4,48}[a-z0-9]\.servicebus\.windows\.net$/.test(fqdn))
        throw new Error('Invalid SERVICE_BUS_NAMESPACE_FQDN');

      const queueName =
        process.env.SERVICE_BUS_TEST_QUEUE ?? 'g6.price-audit.from.pricing';
      const credential = new DefaultAzureCredential({
        managedIdentityClientId: process.env.AZURE_CLIENT_ID,
      });
      const client = new ServiceBusClient(fqdn, credential);
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
          subject: 'pricing.price.changed',
          contentType: 'application/json',
          timeToLive: 60_000,
          body: {
            message_id: messageId,
            correlation_id: correlationId,
            name: 'pricing.price.changed',
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
    }, 30_000);
  },
);
