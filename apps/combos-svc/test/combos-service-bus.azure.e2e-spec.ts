import { randomUUID } from 'node:crypto';
import { ManagedIdentityCredential } from '@azure/identity';
import {
  ServiceBusClient,
  type ServiceBusReceivedMessage,
  type ServiceBusReceiver,
} from '@azure/service-bus';
import { Pool, type PoolClient } from 'pg';
import { CombosEventConsumer } from '../src/messaging/combos-event-consumer.js';
import {
  CombosServiceBus,
  type CombosEventQueue,
} from '../src/messaging/combos-service-bus.js';
import type { CombosDatabase } from '../src/persistence/combos.database.js';
import { CombosRepository } from '../src/persistence/combos.repository.js';

const realAzureEnabled = process.env.G6_H5_COMBOS_REAL_AZURE === '1';

const LAB_NAMESPACE_REGEX =
  /^g6-sb-h5-int-[a-z0-9]{13}\.servicebus\.windows\.net$/;
const NON_ZERO_UUID_REGEX =
  /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const ZERO_UUID_REGEX = /^0{8}-0{4}-0{4}-0{4}-0{12}$/;
const RESERVATION_REGEX = /^[A-Za-z0-9._:-]{4,64}$/;

function assertIsolatedLabEnvironment() {
  if (process.env.G6_H5_COMBOS_LAB_AUTHORIZED !== 'true') {
    throw new Error('G6_H5_COMBOS_LAB_AUTHORIZED=true is required');
  }
  if (process.env.G6_H5_LAB_QUEUES_EXCLUSIVE !== 'true') {
    throw new Error(
      'G6_H5_LAB_QUEUES_EXCLUSIVE=true is required; shared queues are forbidden',
    );
  }
  const reservationId = process.env.G6_H5_LAB_RESERVATION_ID?.trim() ?? '';
  if (!RESERVATION_REGEX.test(reservationId)) {
    throw new Error(
      'G6_H5_LAB_RESERVATION_ID is required to prove exclusive lab reservation',
    );
  }
  const ns = process.env.G6_H5_LAB_NAMESPACE_FQDN?.trim() ?? '';
  if (!LAB_NAMESPACE_REGEX.test(ns)) {
    throw new Error(
      'G6_H5_LAB_NAMESPACE_FQDN must match dedicated lab pattern g6-sb-h5-int-*.servicebus.windows.net',
    );
  }
  const catalogQueue =
    (process.env.G6_H5_LAB_CATALOG_QUEUE?.trim() as CombosEventQueue | undefined) ??
    'g6.combos.from.catalog';
  const inventoryQueue =
    (process.env.G6_H5_LAB_INVENTORY_QUEUE?.trim() as CombosEventQueue | undefined) ??
    'g6.combos.from.inventory';
  if (
    catalogQueue !== 'g6.combos.from.catalog' ||
    inventoryQueue !== 'g6.combos.from.inventory'
  ) {
    throw new Error(
      'G6_H5_LAB_CATALOG_QUEUE and G6_H5_LAB_INVENTORY_QUEUE must match authorized Combos queues',
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
    reservationId,
    catalogQueue,
    inventoryQueue,
    catalogClientId,
    inventoryClientId,
    combosClientId,
    pgUrl: pgUrl.href,
    dbName,
  };
}

async function receiveExclusiveMessage(
  receiver: ServiceBusReceiver,
  expectedMessageId: string,
  timeoutMs = 15_000,
): Promise<ServiceBusReceivedMessage> {
  const [msg] = await receiver.receiveMessages(1, {
    maxWaitTimeInMs: timeoutMs,
    abortSignal: AbortSignal.timeout(timeoutMs + 2000),
  });
  if (!msg) {
    throw new Error(`EXCLUSIVE_MESSAGE_TIMEOUT:${expectedMessageId}`);
  }
  if (msg.messageId !== expectedMessageId) {
    // Fail-closed immediately without calling abandonMessage on a foreign message.
    throw new Error(
      `FOREIGN_MESSAGE_ON_EXCLUSIVE_LAB_QUEUE:expected=${expectedMessageId}:actual=${String(msg.messageId)}`,
    );
  }
  return msg;
}

async function seedComboAtomically(
  pool: Pool,
  input: {
    comboId: string;
    name: string;
    itemId: string;
    itemSecondId: string;
    sku: string;
    skuSecond: string;
  },
) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      "INSERT INTO combos.combos(id, name, combo_price, currency) VALUES ($1, $2, 50, 'PEN')",
      [input.comboId, input.name],
    );
    await client.query(
      'INSERT INTO combos.combo_items(id, combo_id, sku, quantity) VALUES ($1, $2, $3, 1), ($4, $2, $5, 1)',
      [input.itemId, input.comboId, input.sku, input.itemSecondId, input.skuSecond],
    );
    await client.query(
      "INSERT INTO combos.component_projection(combo_item_id, catalog_deactivated, projected_available, inventory_observed_at) VALUES ($1, false, 4, '2026-01-01T00:00:00Z')",
      [input.itemId],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

describe.skipIf(!realAzureEnabled)(
  'Combos H5 Azure Service Bus opt-in E2E (exclusive reserved lab only; excludes catalog.product.deactivated until G7 M2M lab)',
  () => {
    it('Suite A: SDK + handler + PostgreSQL (R05 SKU, R12 stock, ACK loss, Catalog precedence, and DLQ verification)', async () => {
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

      const catalogSender = catalogClient.createSender(lab.catalogQueue);
      const inventorySender = inventoryClient.createSender(lab.inventoryQueue);
      const catalogReceiver = combosClient.createReceiver(lab.catalogQueue, {
        receiveMode: 'peekLock',
        skipParsingBodyAsJson: true,
      });
      const catalogDlqReceiver = combosClient.createReceiver(lab.catalogQueue, {
        subQueueType: 'deadLetter',
        receiveMode: 'peekLock',
        skipParsingBodyAsJson: true,
      });
      const inventoryReceiver = combosClient.createReceiver(
        lab.inventoryQueue,
        {
          receiveMode: 'peekLock',
          skipParsingBodyAsJson: true,
        },
      );

      const runId = randomUUID();
      const comboId = randomUUID();
      const itemId = randomUUID();
      const itemSecondId = randomUUID();
      const sku = `H5-LAB-A-SKU-${runId}`;
      const skuSecond = `H5-LAB-A-SKU2-${runId}`;
      const r05MessageId = `h5-lab-a-r05-${runId}`;
      const r12MessageId = `h5-lab-a-r12-${runId}`;
      const invalidMessageId = `h5-lab-a-inv-${runId}`;

      try {
        await seedComboAtomically(pool, {
          comboId,
          name: `H5 Lab A ${lab.reservationId} ${runId}`,
          itemId,
          itemSecondId,
          sku,
          skuSecond,
        });

        async function deliverWithAckLossAndRedelivery(
          queue: CombosEventQueue,
          receiver: ServiceBusReceiver,
          messageId: string,
        ) {
          const first = await receiveExclusiveMessage(receiver, messageId);
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

          const redelivery = await receiveExclusiveMessage(receiver, messageId);
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
          lab.catalogQueue,
          catalogReceiver,
          r05MessageId,
        );

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
          lab.inventoryQueue,
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

        // DLQ verification (COM-AUD-14): send invalid wrong-queue message, verify deadLetterMessage + real DLQ inspection
        await catalogSender.sendMessages({
          body: Buffer.from(JSON.stringify(r12Envelope), 'utf8'),
          messageId: invalidMessageId,
          correlationId: `h5-lab-corr-inv-${runId}`,
          subject: 'inventory.stock.changed',
          contentType: 'application/json',
        });
        const invalidDelivery = await receiveExclusiveMessage(
          catalogReceiver,
          invalidMessageId,
        );
        const dlqSpy = vi.spyOn(catalogReceiver, 'deadLetterMessage');
        await consumer.processServiceBusDelivery(
          lab.catalogQueue,
          catalogReceiver,
          invalidDelivery,
        );
        expect(dlqSpy).toHaveBeenCalledWith(
          invalidDelivery,
          expect.objectContaining({
            deadLetterReason: 'EVENT_NOT_ALLOWED_FOR_QUEUE',
          }),
        );
        const dlqMsg = await receiveExclusiveMessage(
          catalogDlqReceiver,
          invalidMessageId,
        );
        expect(dlqMsg.deadLetterReason).toBe('EVENT_NOT_ALLOWED_FOR_QUEUE');
        await catalogDlqReceiver.completeMessage(dlqMsg);

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
          catalogDlqReceiver.close(),
          inventoryReceiver.close(),
          catalogClient.close(),
          inventoryClient.close(),
          combosClient.close(),
          pool.end(),
        ]);
      }
    }, 120_000);

    it('Suite B: real CombosServiceBus runtime startup, readiness, R05+R12 subscribe settlement, and clean shutdown (COM-AUD-15)', async () => {
      const lab = assertIsolatedLabEnvironment();
      const pool = new Pool({
        connectionString: lab.pgUrl,
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
      const bus = new CombosServiceBus(
        {
          provider: 'AZURE_SERVICE_BUS',
          enabled: true,
          namespace: lab.ns,
          clientId: lab.combosClientId,
        },
        (queue, receiver, message) =>
          consumer.processServiceBusDelivery(queue, receiver, message),
        { probeIntervalMs: 1000 },
      );

      const makeSenderClient = (clientId: string) =>
        new ServiceBusClient(
          lab.ns,
          new ManagedIdentityCredential({ clientId }),
          { retryOptions: { maxRetries: 1, timeoutInMs: 8000 } },
        );
      const catalogClient = makeSenderClient(lab.catalogClientId);
      const inventoryClient = makeSenderClient(lab.inventoryClientId);
      const catalogSender = catalogClient.createSender(lab.catalogQueue);
      const inventorySender = inventoryClient.createSender(lab.inventoryQueue);

      const runId = randomUUID();
      const comboId = randomUUID();
      const itemId = randomUUID();
      const itemSecondId = randomUUID();
      const sku = `H5-LAB-B-SKU-${runId}`;
      const skuSecond = `H5-LAB-B-SKU2-${runId}`;
      const r05MessageId = `h5-lab-b-r05-${runId}`;
      const r12MessageId = `h5-lab-b-r12-${runId}`;

      try {
        await seedComboAtomically(pool, {
          comboId,
          name: `H5 Lab B ${lab.reservationId} ${runId}`,
          itemId,
          itemSecondId,
          sku,
          skuSecond,
        });

        await bus.start();
        expect(bus.available).toBe(true);
        const states = bus.getQueueStates();
        expect(states[lab.catalogQueue]).toMatchObject({
          phase: 'SUBSCRIBED',
          linkReady: true,
          subscribed: true,
          ready: true,
        });
        expect(states[lab.inventoryQueue]).toMatchObject({
          phase: 'SUBSCRIBED',
          linkReady: true,
          subscribed: true,
          ready: true,
        });

        await catalogSender.sendMessages({
          body: Buffer.from(
            JSON.stringify({
              message_id: r05MessageId,
              schema_version: 1,
              occurred_at: new Date().toISOString(),
              correlation_id: `h5-lab-b-corr-r05-${runId}`,
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
            }),
            'utf8',
          ),
          messageId: r05MessageId,
          correlationId: `h5-lab-b-corr-r05-${runId}`,
          subject: 'catalog.sku.deactivated',
          contentType: 'application/json',
        });

        await inventorySender.sendMessages({
          body: Buffer.from(
            JSON.stringify({
              message_id: r12MessageId,
              schema_version: 2,
              occurred_at: new Date().toISOString(),
              correlation_id: `h5-lab-b-corr-r12-${runId}`,
              causation_id: null,
              operation_id: randomUUID(),
              producer: 'inventory-svc',
              kind: 'event',
              name: 'inventory.stock.changed',
              data: {
                sku: skuSecond,
                location_id: randomUUID(),
                on_hand: 8,
                reserved: 0,
                blocked: 0,
                available: 8,
                estado: 'DISPONIBLE',
                stock_version: 1,
                updated_at: new Date().toISOString(),
              },
            }),
            'utf8',
          ),
          messageId: r12MessageId,
          correlationId: `h5-lab-b-corr-r12-${runId}`,
          subject: 'inventory.stock.changed',
          contentType: 'application/json',
        });

        const deadline = Date.now() + 20_000;
        let processedCount = 0;
        while (Date.now() < deadline) {
          const inbox = await pool.query<{ count: string }>(
            "SELECT count(*)::text AS count FROM combos.inbox WHERE message_id = ANY($1::text[]) AND result = 'PROCESSED'",
            [[r05MessageId, r12MessageId]],
          );
          processedCount = Number(inbox.rows[0]?.count ?? '0');
          if (processedCount === 2) break;
          await new Promise((r) => setTimeout(r, 250));
        }
        expect(processedCount).toBe(2);

        await bus.close();
        expect(bus.available).toBe(false);
        expect(bus.getQueueStates()[lab.catalogQueue].phase).toBe('STOPPED');
        expect(bus.getQueueStates()[lab.inventoryQueue].phase).toBe('STOPPED');
      } finally {
        await bus.close().catch(() => undefined);
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
          catalogClient.close(),
          inventoryClient.close(),
          pool.end(),
        ]);
      }
    }, 120_000);
  },
);
