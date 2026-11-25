import { randomUUID } from 'node:crypto';
import { ManagedIdentityCredential } from '@azure/identity';
import {
  ServiceBusClient,
  type ServiceBusReceivedMessage,
  type ServiceBusReceiver,
} from '@azure/service-bus';
import { Pool, type PoolClient } from 'pg';
import { CombosEventConsumer } from '../src/messaging/combos-event-consumer.js';
import type { CombosEventQueue } from '../src/messaging/combos-service-bus.js';
import type { CombosDatabase } from '../src/persistence/combos.database.js';
import { CombosRepository } from '../src/persistence/combos.repository.js';

const realAzureEnabled = process.env.G6_H5_COMBOS_REAL_AZURE === '1';

const LAB_NAMESPACE_REGEX =
  /^g6-sb-h5-int-[a-z0-9]{13}\.servicebus\.windows\.net$/;
const NON_ZERO_UUID_REGEX =
  /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const ZERO_UUID_REGEX = /^0{8}-0{4}-0{4}-0{4}-0{12}$/;

function assertIsolatedLabEnvironment() {
  if (process.env.G6_H5_COMBOS_LAB_AUTHORIZED !== 'true') {
    throw new Error('G6_H5_COMBOS_LAB_AUTHORIZED=true is required');
  }
  const ns = process.env.G6_H5_LAB_NAMESPACE_FQDN?.trim() ?? '';
  if (!LAB_NAMESPACE_REGEX.test(ns)) {
    throw new Error(
      'G6_H5_LAB_NAMESPACE_FQDN must match dedicated lab pattern g6-sb-h5-int-*.servicebus.windows.net',
    );
  }
  const catalogClientId = process.env.G6_H5_LAB_CATALOG_CLIENT_ID?.trim() ?? '';
  const inventoryClientId =
    process.env.G6_H5_LAB_INVENTORY_CLIENT_ID?.trim() ?? '';
  const combosClientId = process.env.G6_H5_LAB_COMBOS_CLIENT_ID?.trim() ?? '';
  const ids = [catalogClientId, inventoryClientId, combosClientId];
  if (
    !ids.every(
      (id) => NON_ZERO_UUID_REGEX.test(id) && !ZERO_UUID_REGEX.test(id),
    ) ||
    new Set(ids.map((id) => id.toLowerCase())).size !== 3
  ) {
    throw new Error(
      'Distinct non-zero lab Managed Identity UUIDs required for CATALOG, INVENTORY and COMBOS',
    );
  }
  const pgUrlRaw = process.env.G6_H5_COMBOS_PG_URL?.trim() ?? '';
  let pgUrl: URL;
  try {
    pgUrl = new URL(pgUrlRaw);
  } catch {
    throw new Error('G6_H5_COMBOS_PG_URL must be a valid PostgreSQL URL');
  }
  if (
    !['postgres:', 'postgresql:'].includes(pgUrl.protocol) ||
    pgUrl.hostname.toLowerCase().includes('supabase') ||
    !['localhost', '127.0.0.1', '::1', '[::1]'].includes(
      pgUrl.hostname.toLowerCase(),
    )
  ) {
    throw new Error(
      'G6_H5_COMBOS_PG_URL must target a local disposable PostgreSQL instance, never a shared/cloud database',
    );
  }
  const dbName = pgUrl.pathname.replace(/^\//, '');
  if (
    dbName !== 'combos_test' &&
    !dbName.startsWith('combos_h5_lab_') &&
    !dbName.startsWith('g6_lab_')
  ) {
    throw new Error(
      'G6_H5_COMBOS_PG_URL database name must be disposable (combos_test, combos_h5_lab_*, or g6_lab_*)',
    );
  }
  return {
    ns,
    catalogClientId,
    inventoryClientId,
    combosClientId,
    pgUrl: pgUrl.href,
    dbName,
  };
}

async function receiveOwnedMessage(
  receiver: ServiceBusReceiver,
  expectedMessageId: string,
  timeoutMs = 15_000,
): Promise<ServiceBusReceivedMessage> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = Math.max(1000, deadline - Date.now());
    const batch = await receiver.receiveMessages(5, {
      maxWaitTimeInMs: Math.min(5000, remaining),
      abortSignal: AbortSignal.timeout(remaining),
    });
    let matched: ServiceBusReceivedMessage | undefined;
    for (const msg of batch) {
      if (msg.messageId === expectedMessageId && !matched) {
        matched = msg;
      } else {
        // Never consume or delete messages owned by another process.
        await receiver.abandonMessage(msg).catch(() => undefined);
      }
    }
    if (matched) return matched;
  }
  throw new Error(`OWNED_MESSAGE_TIMEOUT:${expectedMessageId}`);
}

describe.skipIf(!realAzureEnabled)(
  'Combos H5 Azure Service Bus R05/R12 opt-in E2E (isolated lab only; excludes catalog.product.deactivated until G7 M2M lab)',
  () => {
    it('verifies R05 SKU deactivation, R12 stock change, ACK loss redelivery, Catalog precedence, and invalid message DLQ', async () => {
      const lab = assertIsolatedLabEnvironment();
      const pool = new Pool({
        connectionString: lab.pgUrl,
        connectionTimeoutMillis: 3000,
      });
      const dbIdentity = await pool.query<{ db: string }>(
        'SELECT current_database() AS db',
      );
      if (dbIdentity.rows[0]?.db !== lab.dbName) {
        await pool.end();
        throw new Error('POSTGRES_DATABASE_MISMATCH');
      }

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

      const makeClient = (clientId: string) =>
        new ServiceBusClient(
          lab.ns,
          new ManagedIdentityCredential({ clientId }),
          { retryOptions: { maxRetries: 1, timeoutInMs: 8000 } },
        );
      const catalogClient = makeClient(lab.catalogClientId);
      const inventoryClient = makeClient(lab.inventoryClientId);
      const combosClient = makeClient(lab.combosClientId);

      const catalogQueue: CombosEventQueue = 'g6.combos.from.catalog';
      const inventoryQueue: CombosEventQueue = 'g6.combos.from.inventory';
      const catalogSender = catalogClient.createSender(catalogQueue);
      const inventorySender = inventoryClient.createSender(inventoryQueue);
      const catalogReceiver = combosClient.createReceiver(catalogQueue, {
        receiveMode: 'peekLock',
        skipParsingBodyAsJson: true,
      });
      const inventoryReceiver = combosClient.createReceiver(inventoryQueue, {
        receiveMode: 'peekLock',
        skipParsingBodyAsJson: true,
      });

      const runId = randomUUID();
      const comboId = randomUUID();
      const itemId = randomUUID();
      const itemSecondId = randomUUID();
      const sku = `H5-LAB-SKU-${runId}`;
      const skuSecond = `H5-LAB-SKU2-${runId}`;
      const r05MessageId = `h5-lab-r05-${runId}`;
      const r12MessageId = `h5-lab-r12-${runId}`;
      const invalidMessageId = `h5-lab-inv-${runId}`;

      try {
        await pool.query('BEGIN');
        await pool.query(
          "INSERT INTO combos.combos(id, name, combo_price, currency) VALUES ($1, $2, 50, 'PEN')",
          [comboId, `H5 Lab Combo ${runId}`],
        );
        await pool.query(
          'INSERT INTO combos.combo_items(id, combo_id, sku, quantity) VALUES ($1, $2, $3, 1), ($4, $2, $5, 1)',
          [itemId, comboId, sku, itemSecondId, skuSecond],
        );
        await pool.query(
          "INSERT INTO combos.component_projection(combo_item_id, catalog_deactivated, projected_available, inventory_observed_at) VALUES ($1, false, 4, '2026-01-01T00:00:00Z')",
          [itemId],
        );
        await pool.query('COMMIT');

        async function deliverWithAckLossAndRedelivery(
          queue: CombosEventQueue,
          receiver: ServiceBusReceiver,
          messageId: string,
        ) {
          const first = await receiveOwnedMessage(receiver, messageId);
          let simulatedLoss = false;
          await expect(
            consumer.processServiceBusDelivery(
              queue,
              {
                completeMessage: async (msg) => {
                  const inbox = await pool.query(
                    'SELECT result FROM combos.inbox WHERE message_id = $1',
                    [messageId],
                  );
                  expect(inbox.rows).toEqual([{ result: 'PROCESSED' }]);
                  await receiver.abandonMessage(msg);
                  simulatedLoss = true;
                  throw new Error('SIMULATED_ACK_LOSS');
                },
                abandonMessage: receiver.abandonMessage.bind(receiver),
                deadLetterMessage: receiver.deadLetterMessage.bind(receiver),
              },
              first,
            ),
          ).rejects.toThrow('SIMULATED_ACK_LOSS');
          expect(simulatedLoss).toBe(true);

          const redelivery = await receiveOwnedMessage(receiver, messageId);
          expect(redelivery.deliveryCount ?? 0).toBeGreaterThan(
            first.deliveryCount ?? 0,
          );
          await consumer.processServiceBusDelivery(queue, receiver, redelivery);
          const inboxRows = await pool.query(
            'SELECT result FROM combos.inbox WHERE message_id = $1',
            [messageId],
          );
          expect(inboxRows.rows).toEqual([{ result: 'PROCESSED' }]);
        }

        // 1. R05 SKU deactivation on g6.combos.from.catalog
        const r05Envelope = {
          message_id: r05MessageId,
          schema_version: 1,
          occurred_at: new Date().toISOString(),
          correlation_id: `h5-lab-corr-r05-${runId}`,
          causation_id: null,
          operation_id: randomUUID(),
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
        await catalogSender.sendMessages({
          body: Buffer.from(JSON.stringify(r05Envelope), 'utf8'),
          messageId: r05MessageId,
          correlationId: r05Envelope.correlation_id,
          subject: 'catalog.sku.deactivated',
          contentType: 'application/json',
          applicationProperties: {
            producer: 'catalog-svc',
            schema_version: 1,
            route_version: 1,
          },
        });
        await deliverWithAckLossAndRedelivery(
          catalogQueue,
          catalogReceiver,
          r05MessageId,
        );

        // 2. R12 positive stock change on g6.combos.from.inventory must NOT reactivate Catalog-deactivated SKU
        const r12Envelope = {
          message_id: r12MessageId,
          schema_version: 2,
          occurred_at: new Date().toISOString(),
          correlation_id: `h5-lab-corr-r12-${runId}`,
          causation_id: null,
          operation_id: randomUUID(),
          producer: 'inventory-svc',
          kind: 'event',
          name: 'inventory.stock.changed',
          data: {
            sku,
            location_id: randomUUID(),
            on_hand: 12,
            reserved: 0,
            blocked: 0,
            available: 12,
            estado: 'DISPONIBLE',
            stock_version: 1,
            updated_at: new Date().toISOString(),
          },
        };
        await inventorySender.sendMessages({
          body: Buffer.from(JSON.stringify(r12Envelope), 'utf8'),
          messageId: r12MessageId,
          correlationId: r12Envelope.correlation_id,
          subject: 'inventory.stock.changed',
          contentType: 'application/json',
          applicationProperties: {
            producer: 'inventory-svc',
            schema_version: 2,
            route_version: 1,
          },
        });
        await deliverWithAckLossAndRedelivery(
          inventoryQueue,
          inventoryReceiver,
          r12MessageId,
        );

        const projections = await pool.query(
          'SELECT combo_item_id, catalog_deactivated, projected_available, inventory_observed_at FROM combos.component_projection WHERE combo_item_id = ANY($1::uuid[])',
          [[itemId, itemSecondId]],
        );
        expect(projections.rows).toEqual([
          {
            combo_item_id: itemId,
            catalog_deactivated: true,
            projected_available: null,
            inventory_observed_at: expect.any(Date),
          },
        ]);

        // 3. Unexpected/wrong-queue message is dead-lettered cleanly without affecting projections
        await catalogSender.sendMessages({
          body: Buffer.from(JSON.stringify(r12Envelope), 'utf8'),
          messageId: invalidMessageId,
          correlationId: `h5-lab-corr-inv-${runId}`,
          subject: 'inventory.stock.changed',
          contentType: 'application/json',
        });
        const invalidDelivery = await receiveOwnedMessage(
          catalogReceiver,
          invalidMessageId,
        );
        await consumer.processServiceBusDelivery(
          catalogQueue,
          catalogReceiver,
          invalidDelivery,
        );
        const invalidInbox = await pool.query(
          'SELECT 1 FROM combos.inbox WHERE message_id = $1',
          [invalidMessageId],
        );
        expect(invalidInbox.rowCount).toBe(0);
      } finally {
        await pool
          .query('DELETE FROM combos.inbox WHERE message_id = ANY($1::text[])', [
            [r05MessageId, r12MessageId],
          ])
          .catch(() => undefined);
        await pool
          .query('DELETE FROM combos.combos WHERE id = $1', [comboId])
          .catch(() => undefined);
        await Promise.allSettled([
          catalogSender.close(),
          inventorySender.close(),
          catalogReceiver.close(),
          inventoryReceiver.close(),
          catalogClient.close(),
          inventoryClient.close(),
          combosClient.close(),
          pool.end(),
        ]);
      }
    }, 120_000);
  },
);
