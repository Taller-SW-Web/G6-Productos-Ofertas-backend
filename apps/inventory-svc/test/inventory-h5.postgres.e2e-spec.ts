import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { InventorySvcModule } from '../src/inventory-svc.module.js';
import { ProblemDetailsFilter } from '../src/errors/problem-details.filter.js';
import { InventoryAuthGuard } from '../src/auth/inventory-auth.guard.js';
import {
  createCryptographicJwt,
  TEST_ISSUER,
  TEST_PUBLIC_KEY,
} from './crypto-test-token.helper.js';
import { DatabaseService } from '../src/database/database.service.js';
import { DashboardService } from '../src/dashboard/dashboard.service.js';
import { InventoryWorkersService } from '../src/workers/inventory-workers.service.js';
import {
  insertInventoryDeliveries,
  InventoryDeliveryStore,
  INVENTORY_QUEUES,
} from '../src/messaging/service-bus-deliveries.js';
import { InventoryServiceBusRelay } from '../src/messaging/service-bus-relay.js';

const previousDatabaseUrl = process.env.DATABASE_URL;

describe('inventory-svc H5 + H01/H02 PostgreSQL 17 descartable', () => {
  const database = new DatabaseService();
  const runId = randomUUID().replaceAll('-', '').slice(0, 12);
  const dockerLabel = `inventory.h5.pg.run=${runId}`;
  const pgContainer = `inventory-h5-pg-${runId}`;
  let pgUrl = '';

  function docker(args: string[], input?: string): string {
    return execFileSync('docker', args, {
      encoding: 'utf8',
      input,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 120_000,
    }).trim();
  }

  function cleanupContainer(): void {
    try {
      const labels = JSON.parse(
        docker(['inspect', '--format', '{{json .Config.Labels}}', pgContainer]),
      ) as Record<string, string>;
      if (labels['inventory.h5.pg.run'] === runId) {
        docker(['rm', '-f', '-v', pgContainer]);
      }
    } catch {
      // El contenedor no llegó a crearse o ya fue retirado.
    }
  }

  beforeAll(async () => {
    const password = randomBytes(24).toString('hex');
    try {
      docker([
        'run',
        '-d',
        '--name',
        pgContainer,
        '--label',
        dockerLabel,
        '-p',
        '127.0.0.1::5432',
        '-e',
        'POSTGRES_USER=inventory_test',
        '-e',
        `POSTGRES_PASSWORD=${password}`,
        '-e',
        'POSTGRES_DB=inventory_it',
        'postgres:17-alpine',
      ]);
      const pgPort = docker(['port', pgContainer, '5432/tcp'])
        .split(':')
        .at(-1);
      if (!pgPort)
        throw new Error('Docker no asignó puerto loopback a PostgreSQL.');
      pgUrl = `postgresql://inventory_test:${password}@127.0.0.1:${pgPort}/inventory_it?sslmode=disable`;

      await waitForContainer(
        pgContainer,
        'pg_isready -h 127.0.0.1 -U inventory_test -d inventory_it',
      );

      const docsRoot = process.env.G6_DOCS_ROOT
        ? pathToFileURL(
            resolve(process.env.G6_DOCS_ROOT, 'datos/inventory-svc') + '/',
          )
        : new URL('../../../../docs/datos/inventory-svc/', import.meta.url);
      const initial = await readFile(
        new URL('migration.sql', docsRoot),
        'utf8',
      );
      const incremental = await readFile(
        new URL(
          'migrations/0002_order_id_operaciones_disponibilidad.sql',
          docsRoot,
        ),
        'utf8',
      );
      const inventoryCandidateMigration = await readFile(
        new URL(
          '../migrations/20261104_0001_lifecycle_offline_reconciliation.sql',
          import.meta.url,
        ),
        'utf8',
      );
      const h5CandidateMigration = await readFile(
        new URL(
          '../migrations-candidate/h5/0001_outbox_delivery.sql',
          import.meta.url,
        ),
        'utf8',
      );

      const psql = (user: string, sqlInput: string) =>
        docker(
          [
            'exec',
            '-i',
            pgContainer,
            'psql',
            '-v',
            'ON_ERROR_STOP=1',
            '-U',
            user,
            '-d',
            'inventory_it',
          ],
          sqlInput,
        );

      psql('inventory_test', initial);
      psql('inventory_test', `BEGIN;\n${incremental}\nCOMMIT;`);
      psql('inventory_test', inventoryCandidateMigration);
      psql(
        'inventory_test',
        `DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'po_inventory_owner') THEN
    CREATE ROLE po_inventory_owner WITH LOGIN SUPERUSER;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'inventory_app') THEN
    CREATE ROLE inventory_app WITH LOGIN;
  END IF;
END
$$;
ALTER SCHEMA inventory OWNER TO po_inventory_owner;
GRANT ALL ON SCHEMA inventory TO po_inventory_owner;
GRANT USAGE ON SCHEMA inventory TO inventory_app;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA inventory TO inventory_app;
GRANT inventory_app TO inventory_test;`,
      );
      psql('po_inventory_owner', h5CandidateMigration);

      process.env.DATABASE_URL = pgUrl;
      await database.onModuleInit();
    } catch (error) {
      cleanupContainer();
      throw error;
    }
  }, 120_000);

  afterAll(async () => {
    await database.onModuleDestroy().catch(() => undefined);
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    cleanupContainer();
  }, 60_000);

  describe('Azure Service Bus H5 — outbox_delivery y Store con PostgreSQL desechable', () => {
    const deliveryStore = new InventoryDeliveryStore(database);

    beforeAll(() => {
      process.env.MESSAGING_PROVIDER = 'AZURE_SERVICE_BUS';
    });

    afterAll(() => {
      delete process.env.MESSAGING_PROVIDER;
    });

    it('Outbox y Delivery se confirman o revierten en la misma transacción', async () => {
      const committedEventId = randomUUID();
      const abortedEventId = randomUUID();

      // Transacción confirmada (COMMIT)
      await database.transaction(async (tx) => {
        await tx.query(
          `INSERT INTO inventory.outbox
             (event_id, event_type, aggregate_type, aggregate_id, payload, status, created_at)
           VALUES ($1, 'inventory.stock.changed', 'stock', 'SKU-H5-01', '{}', 'PENDING', now())`,
          [committedEventId],
        );
        await insertInventoryDeliveries(tx, {
          event_id: committedEventId,
          event_type: 'inventory.stock.changed',
        });
      });

      const committedOutbox = await database.query(
        `SELECT event_id FROM inventory.outbox WHERE event_id = $1`,
        [committedEventId],
      );
      const committedDeliveries = await database.query(
        `SELECT message_id, destination FROM inventory.outbox_delivery WHERE message_id = $1`,
        [committedEventId],
      );
      expect(committedOutbox.rowCount).toBe(1);
      expect(committedDeliveries.rowCount).toBe(2);

      // Transacción revertida (ROLLBACK)
      await expect(
        database.transaction(async (tx) => {
          await tx.query(
            `INSERT INTO inventory.outbox
               (event_id, event_type, aggregate_type, aggregate_id, payload, status, created_at)
             VALUES ($1, 'inventory.stock.changed', 'stock', 'SKU-H5-01', '{}', 'PENDING', now())`,
            [abortedEventId],
          );
          await insertInventoryDeliveries(tx, {
            event_id: abortedEventId,
            event_type: 'inventory.stock.changed',
          });
          throw new Error('Fallo simulado en la transacción de negocio');
        }),
      ).rejects.toThrow('Fallo simulado en la transacción de negocio');

      const abortedOutbox = await database.query(
        `SELECT event_id FROM inventory.outbox WHERE event_id = $1`,
        [abortedEventId],
      );
      const abortedDeliveries = await database.query(
        `SELECT message_id FROM inventory.outbox_delivery WHERE message_id = $1`,
        [abortedEventId],
      );
      expect(abortedOutbox.rowCount).toBe(0);
      expect(abortedDeliveries.rowCount).toBe(0);
    });

    it('un evento inventory.stock.changed genera exactamente dos entregas: Combos y Promotions', async () => {
      const eventId = randomUUID();
      await database.transaction(async (tx) => {
        await tx.query(
          `INSERT INTO inventory.outbox
             (event_id, event_type, aggregate_type, aggregate_id, payload, status, created_at)
           VALUES ($1, 'inventory.stock.changed', 'stock', 'SKU-H5-02', '{}', 'PENDING', now())`,
          [eventId],
        );
        await insertInventoryDeliveries(tx, {
          event_id: eventId,
          event_type: 'inventory.stock.changed',
        });
      });

      const deliveries = await database.query<{ destination: string }>(
        `SELECT destination FROM inventory.outbox_delivery WHERE message_id = $1 ORDER BY destination`,
        [eventId],
      );
      expect(deliveries.rowCount).toBe(2);
      expect(deliveries.rows.map((r) => r.destination)).toEqual([
        INVENTORY_QUEUES.COMBOS,
        INVENTORY_QUEUES.PROMOTIONS,
      ]);
    });

    it('dos workers concurrentes no pueden reclamar simultáneamente la misma entrega vigente', async () => {
      const eventId = randomUUID();
      await database.transaction(async (tx) => {
        await tx.query(
          `INSERT INTO inventory.outbox
             (event_id, event_type, aggregate_type, aggregate_id, payload, status, created_at)
           VALUES ($1, 'inventory.sku.initialization.completed', 'stock', 'SKU-H5-03', '{"schema_version":2}', 'PENDING', now())`,
          [eventId],
        );
        await insertInventoryDeliveries(tx, {
          event_id: eventId,
          event_type: 'inventory.sku.initialization.completed',
        });
      });

      const worker1 = new InventoryDeliveryStore(database);
      const worker2 = new InventoryDeliveryStore(database);

      // Limpiar otras entregas pendientes para aislar este test
      await database.query(
        `UPDATE inventory.outbox_delivery SET sent_at = now() WHERE message_id <> $1 AND sent_at IS NULL`,
        [eventId],
      );

      const [claim1, claim2] = await Promise.all([
        worker1.claim(),
        worker2.claim(),
      ]);

      // Exactamente uno gana el claim y el otro obtiene undefined (FOR UPDATE SKIP LOCKED)
      const claims = [claim1, claim2].filter(Boolean);
      expect(claims.length).toBe(1);
      expect(claims[0]?.row.event_id).toBe(eventId);
      expect(claims[0]?.token).toBeDefined();
    });

    it('un lease vencido permite recuperar la entrega', async () => {
      const eventId = randomUUID();
      await database.transaction(async (tx) => {
        await tx.query(
          `INSERT INTO inventory.outbox
             (event_id, event_type, aggregate_type, aggregate_id, payload, status, created_at)
           VALUES ($1, 'inventory.sku.initialization.completed', 'stock', 'SKU-H5-04', '{"schema_version":2}', 'PENDING', now())`,
          [eventId],
        );
        await insertInventoryDeliveries(tx, {
          event_id: eventId,
          event_type: 'inventory.sku.initialization.completed',
        });
      });

      await database.query(
        `UPDATE inventory.outbox_delivery SET sent_at = now() WHERE message_id <> $1 AND sent_at IS NULL`,
        [eventId],
      );

      // Reclamar la entrega
      const claim1 = await deliveryStore.claim();
      expect(claim1).toBeDefined();
      expect(claim1?.row.event_id).toBe(eventId);

      // Segundo intento inmediato no la puede reclamar porque el lease está vigente
      const immediate = await deliveryStore.claim();
      expect(immediate).toBeUndefined();

      // Forzar expiración del lease en PostgreSQL
      await database.query(
        `UPDATE inventory.outbox_delivery
         SET lease_until = clock_timestamp() - interval '1 second'
         WHERE message_id = $1`,
        [eventId],
      );

      // Ahora el lease vencido permite recuperarla
      const reclaimed = await deliveryStore.claim();
      expect(reclaimed).toBeDefined();
      expect(reclaimed?.row.event_id).toBe(eventId);
      expect(reclaimed?.token).not.toBe(claim1?.token);
    });

    it('un token incorrecto o vencido no puede confirmar el envío', async () => {
      const eventId = randomUUID();
      await database.transaction(async (tx) => {
        await tx.query(
          `INSERT INTO inventory.outbox
             (event_id, event_type, aggregate_type, aggregate_id, payload, status, created_at)
           VALUES ($1, 'inventory.sku.initialization.completed', 'stock', 'SKU-H5-05', '{"schema_version":2}', 'PENDING', now())`,
          [eventId],
        );
        await insertInventoryDeliveries(tx, {
          event_id: eventId,
          event_type: 'inventory.sku.initialization.completed',
        });
      });

      await database.query(
        `UPDATE inventory.outbox_delivery SET sent_at = now() WHERE message_id <> $1 AND sent_at IS NULL`,
        [eventId],
      );

      const claim = await deliveryStore.claim();
      expect(claim).toBeDefined();

      // 1. Token incorrecto
      const wrongTokenResult = await deliveryStore.finish(
        { ...claim!, token: randomUUID() },
        'confirmed',
      );
      expect(wrongTokenResult).toBe(false);

      const checkUnsent = await database.query<{ sent_at: string | null }>(
        `SELECT sent_at FROM inventory.outbox_delivery WHERE message_id = $1`,
        [eventId],
      );
      expect(checkUnsent.rows[0].sent_at).toBeNull();

      // 2. Token vencido (lease_until expiró)
      await database.query(
        `UPDATE inventory.outbox_delivery
         SET lease_until = clock_timestamp() - interval '1 second'
         WHERE message_id = $1`,
        [eventId],
      );

      const expiredTokenResult = await deliveryStore.finish(
        claim!,
        'confirmed',
      );
      expect(expiredTokenResult).toBe(false);

      const checkStillUnsent = await database.query<{ sent_at: string | null }>(
        `SELECT sent_at FROM inventory.outbox_delivery WHERE message_id = $1`,
        [eventId],
      );
      expect(checkStillUnsent.rows[0].sent_at).toBeNull();
    });

    it('el fallo de un destino no confirma ni bloquea permanentemente el otro', async () => {
      const eventId = randomUUID();
      await database.transaction(async (tx) => {
        await tx.query(
          `INSERT INTO inventory.outbox
             (event_id, event_type, aggregate_type, aggregate_id, payload, status, created_at)
           VALUES ($1, 'inventory.stock.changed', 'stock', 'SKU-H5-06', '{"schema_version":2}', 'PENDING', now())`,
          [eventId],
        );
        await insertInventoryDeliveries(tx, {
          event_id: eventId,
          event_type: 'inventory.stock.changed',
        });
      });

      await database.query(
        `UPDATE inventory.outbox_delivery SET sent_at = now() WHERE message_id <> $1 AND sent_at IS NULL`,
        [eventId],
      );

      // Reclamar primera entrega y fallar
      const claim1 = await deliveryStore.claim();
      expect(claim1).toBeDefined();
      const fail1 = await deliveryStore.finish(claim1!, 'failed');
      expect(fail1).toBe(true);

      // Reclamar segunda entrega y confirmar
      const claim2 = await deliveryStore.claim();
      expect(claim2).toBeDefined();
      expect(claim2?.destination).not.toBe(claim1?.destination);
      const confirm2 = await deliveryStore.finish(claim2!, 'confirmed');
      expect(confirm2).toBe(true);

      const rows = await database.query<{
        destination: string;
        sent_at: string | null;
        last_error: string | null;
      }>(
        `SELECT destination, sent_at, last_error
         FROM inventory.outbox_delivery
         WHERE message_id = $1
         ORDER BY destination`,
        [eventId],
      );

      const failedDest = rows.rows.find(
        (r) => r.destination === claim1?.destination,
      );
      const confirmedDest = rows.rows.find(
        (r) => r.destination === claim2?.destination,
      );

      expect(failedDest?.sent_at).toBeNull();
      expect(failedDest?.last_error).toBe('SEND_NOT_CONFIRMED');

      expect(confirmedDest?.sent_at).not.toBeNull();
      expect(confirmedDest?.last_error).toBeNull();
    });

    it('un envío no confirmado conserva la entrega pendiente', async () => {
      const eventId = randomUUID();
      await database.transaction(async (tx) => {
        await tx.query(
          `INSERT INTO inventory.outbox
             (event_id, event_type, aggregate_type, aggregate_id, payload, status, created_at)
           VALUES ($1, 'inventory.sku.initialization.completed', 'stock', 'SKU-H5-07', '{"schema_version":2}', 'PENDING', now())`,
          [eventId],
        );
        await insertInventoryDeliveries(tx, {
          event_id: eventId,
          event_type: 'inventory.sku.initialization.completed',
        });
      });

      await database.query(
        `UPDATE inventory.outbox_delivery SET sent_at = now() WHERE message_id <> $1 AND sent_at IS NULL`,
        [eventId],
      );

      const claim = await deliveryStore.claim();
      expect(claim).toBeDefined();

      await deliveryStore.finish(claim!, 'failed');

      const check = await database.query<{
        sent_at: string | null;
        attempts: number;
        next_attempt_at: string;
      }>(
        `SELECT sent_at, attempts, next_attempt_at FROM inventory.outbox_delivery WHERE message_id = $1`,
        [eventId],
      );
      expect(check.rows[0].sent_at).toBeNull();
      expect(check.rows[0].attempts).toBe(1);
      expect(new Date(check.rows[0].next_attempt_at).getTime()).toBeGreaterThan(
        Date.now() - 5000,
      );
    });

    it('una entrega confirmada no vuelve a reclamarse', async () => {
      const eventId = randomUUID();
      await database.transaction(async (tx) => {
        await tx.query(
          `INSERT INTO inventory.outbox
             (event_id, event_type, aggregate_type, aggregate_id, payload, status, created_at)
           VALUES ($1, 'inventory.sku.initialization.completed', 'stock', 'SKU-H5-08', '{"schema_version":2}', 'PENDING', now())`,
          [eventId],
        );
        await insertInventoryDeliveries(tx, {
          event_id: eventId,
          event_type: 'inventory.sku.initialization.completed',
        });
      });

      await database.query(
        `UPDATE inventory.outbox_delivery SET sent_at = now() WHERE message_id <> $1 AND sent_at IS NULL`,
        [eventId],
      );

      const claim = await deliveryStore.claim();
      expect(claim).toBeDefined();

      await deliveryStore.finish(claim!, 'confirmed');

      const nextClaim = await deliveryStore.claim();
      expect(nextClaim).toBeUndefined();
    });

    it('una entrega terminal por tamaño excesivo no se reintenta automáticamente', async () => {
      const eventId = randomUUID();
      await database.transaction(async (tx) => {
        await tx.query(
          `INSERT INTO inventory.outbox
             (event_id, event_type, aggregate_type, aggregate_id, payload, status, created_at)
           VALUES ($1, 'inventory.sku.initialization.completed', 'stock', 'SKU-H5-09', '{"schema_version":2}', 'PENDING', now())`,
          [eventId],
        );
        await insertInventoryDeliveries(tx, {
          event_id: eventId,
          event_type: 'inventory.sku.initialization.completed',
        });
      });

      await database.query(
        `UPDATE inventory.outbox_delivery SET sent_at = now() WHERE message_id <> $1 AND sent_at IS NULL`,
        [eventId],
      );

      const claim = await deliveryStore.claim();
      expect(claim).toBeDefined();

      const finished = await deliveryStore.finish(claim!, 'terminal_too_large');
      expect(finished).toBe(true);

      const row = await database.query<{
        sent_at: string | null;
        last_error: string | null;
        next_attempt_at: string;
      }>(
        `SELECT sent_at, last_error, next_attempt_at::text FROM inventory.outbox_delivery WHERE message_id = $1`,
        [eventId],
      );
      expect(row.rows[0].sent_at).toBeNull();
      expect(row.rows[0].last_error).toBe('MESSAGE_EXCEEDS_256KB');
      expect(row.rows[0].next_attempt_at).toBe('infinity');

      // No se vuelve a reclamar automáticamente
      const reclaimed = await deliveryStore.claim();
      expect(reclaimed).toBeUndefined();
    });

    it('una entrega con payload inválido (cadena no interpretable como envelope) se marca terminal y permite procesar entregas válidas posteriores', async () => {
      const invalidEventId = randomUUID();
      const validEventId = randomUUID();
      const validCanonicalMessageId = randomUUID();

      // 1. Insertar evento con payload inválido: una cadena JSONB que no puede interpretarse como envelope válido
      await database.transaction(async (tx) => {
        await tx.query(
          `INSERT INTO inventory.outbox
             (event_id, event_type, aggregate_type, aggregate_id, payload, status, created_at)
           VALUES ($1, 'inventory.sku.initialization.completed', 'stock', 'SKU-H5-INV', '"cadena-invalida-no-envelope"', 'PENDING', now())`,
          [invalidEventId],
        );
        await insertInventoryDeliveries(tx, {
          event_id: invalidEventId,
          event_type: 'inventory.sku.initialization.completed',
        });
      });

      // 2. Insertar evento válido posterior
      await database.transaction(async (tx) => {
        await tx.query(
          `INSERT INTO inventory.outbox
             (event_id, event_type, aggregate_type, aggregate_id, payload, status, created_at)
           VALUES ($1, 'inventory.sku.initialization.completed', 'stock', 'SKU-H5-VAL', $2::jsonb, 'PENDING', now())`,
          [
            validEventId,
            JSON.stringify({
              message_id: validCanonicalMessageId,
              name: 'inventory.sku.initialization.completed',
              producer: 'inventory-svc',
              schema_version: 2,
            }),
          ],
        );
        await insertInventoryDeliveries(tx, {
          event_id: validEventId,
          event_type: 'inventory.sku.initialization.completed',
        });
      });

      // Limpiar otras entregas pendientes para aislar este test
      await database.query(
        `UPDATE inventory.outbox_delivery SET sent_at = now() WHERE message_id NOT IN ($1, $2) AND sent_at IS NULL`,
        [invalidEventId, validEventId],
      );

      // Crear sender mock para el relay
      const sentMessages: any[] = [];
      const mockSender = {
        createMessageBatch: vi.fn(async () => ({
          count: 1,
          sizeInBytes: 100,
          maxSizeInBytes: 256 * 1024,
          tryAddMessage: (msg: any) => {
            sentMessages.push(msg);
            return true;
          },
        })),
        sendMessages: vi.fn(async () => undefined),
      };
      const senders = new Map([
        [INVENTORY_QUEUES.CATALOG, mockSender as any],
        [INVENTORY_QUEUES.COMBOS, mockSender as any],
        [INVENTORY_QUEUES.PROMOTIONS, mockSender as any],
      ]);
      const relay = new InventoryServiceBusRelay(deliveryStore, senders);

      // Primer publishOne: debe reclamar invalidEventId, rechazarlo contractualmente y marcarlo terminal
      const res1 = await relay.publishOne();
      expect(res1).toBe('terminal-failure');

      const invalidRow = await database.query<{
        sent_at: string | null;
        last_error: string | null;
        next_attempt_at: string;
      }>(
        `SELECT sent_at, last_error, next_attempt_at::text FROM inventory.outbox_delivery WHERE message_id = $1`,
        [invalidEventId],
      );
      expect(invalidRow.rows[0].sent_at).toBeNull();
      expect(invalidRow.rows[0].last_error).toBe('INVALID_OUTBOX_CONTRACT');
      expect(invalidRow.rows[0].next_attempt_at).toBe('infinity');

      // Segundo publishOne: la entrega inválida ya no bloquea; debe procesar la entrega válida posterior
      const res2 = await relay.publishOne();
      expect(res2).toBe('sent');

      const validRow = await database.query<{
        sent_at: string | null;
        last_error: string | null;
      }>(
        `SELECT sent_at, last_error FROM inventory.outbox_delivery WHERE message_id = $1`,
        [validEventId],
      );
      expect(validRow.rows[0].sent_at).not.toBeNull();
      expect(validRow.rows[0].last_error).toBeNull();
      expect(sentMessages[0].messageId).toBe(validCanonicalMessageId);

      // Tercer publishOne: no quedan entregas pendientes
      const res3 = await relay.publishOne();
      expect(res3).toBe('empty');
    });
  });

  describe('DashboardService — alertas y ubicaciones internas H01/H02 en PostgreSQL 17 descartable', () => {
    const dashService = new DashboardService(database);
    const runTag = `dash-${randomUUID().slice(0, 8)}`;
    let activeLocId: string;
    let inactiveLocId: string;
    let emptyLocId: string;
    const skuNormal = `${runTag}-SKU-NORMAL`;
    const skuLow = `${runTag}-SKU-LOW`;
    const skuAgotado = `${runTag}-SKU-AGOTADO`;
    const skuZeroPhysical = `${runTag}-SKU-ZERO-PHYS`;
    const skuExactThreshold = `${runTag}-SKU-EXACT-THRESH`;
    const skuOverride = `${runTag}-SKU-OVERRIDE`;
    const skuInactiveLoc = `${runTag}-SKU-INACTIVE-LOC`;
    const overrideId = randomUUID();
    const globalThresholdId = randomUUID();

    beforeAll(async () => {
      // 1. Crear ubicaciones de prueba efímeras: 2 activas y 1 inactiva
      const loc1 = await database.query<{ id: string }>(
        `INSERT INTO inventory.locations(code, name, type, active)
         VALUES ($1, $2, 'TIENDA', true) RETURNING id`,
        [`A-${runTag}-LOC-1`, `Active Location ${runTag}`],
      );
      activeLocId = loc1.rows[0].id;

      const loc2 = await database.query<{ id: string }>(
        `INSERT INTO inventory.locations(code, name, type, active)
         VALUES ($1, $2, 'TIENDA', false) RETURNING id`,
        [`B-${runTag}-LOC-2`, `Inactive Location ${runTag}`],
      );
      inactiveLocId = loc2.rows[0].id;

      const loc3 = await database.query<{ id: string }>(
        `INSERT INTO inventory.locations(code, name, type, active)
         VALUES ($1, $2, 'ALMACEN', true) RETURNING id`,
        [`C-${runTag}-LOC-3`, `Empty Location ${runTag}`],
      );
      emptyLocId = loc3.rows[0].id;

      // 2. Fijar un umbral global determinista (10) y verificar que ningún
      // bloque previo haya dejado un override global ambiente. El contrato
      // clasifica STOCK_BAJO cuando available > 0 y <= umbral efectivo.
      const ambientGlobal = await database.query<{ total: number }>(
        `SELECT count(*)::int AS total
         FROM inventory.stock_threshold_override
         WHERE sku_id IS NULL AND location_id IS NULL`,
      );
      expect(ambientGlobal.rows[0]?.total).toBe(0);
      await database.query(
        `INSERT INTO inventory.stock_threshold_override
           (id, sku_id, location_id, umbral_efectivo)
         VALUES ($1, NULL, NULL, 10)`,
        [globalThresholdId],
      );

      // 3. Insertar umbral override para skuOverride (umbral = 2)
      await database.query(
        `INSERT INTO inventory.stock_threshold_override
           (id, sku_id, location_id, umbral_efectivo)
         VALUES ($1, $2, NULL, 2)`,
        [overrideId, skuOverride],
      );

      // 4. Insertar saldos de stock para pruebas de alertas y disponibilidad.
      // IMPORTANTE: "available" es columna GENERATED ALWAYS en PostgreSQL; no se puede insertar.
      // PostgreSQL la calcula como GREATEST(0, on_hand - reserved - blocked).
      // on_hand, reserved y blocked son NOT NULL con restricciones no negativas.
      await database.query(
        `INSERT INTO inventory.stock_balance (sku_id, location_id, on_hand, reserved, blocked)
         VALUES
           ($1, $7, 30, 0, 0),
           ($2, $7,  5, 0, 0),
           ($3, $7,  0, 0, 0),
           ($4, $7,  0, 0, 0),
           ($5, $7, 10, 0, 0),
           ($6, $7,  4, 0, 0),
           ($8, $9,  1, 0, 0)`,
        [
          skuNormal,
          skuLow,
          skuAgotado,
          skuZeroPhysical,
          skuExactThreshold,
          skuOverride,
          activeLocId,
          skuInactiveLoc,
          inactiveLocId,
        ],
      );
    });

    afterAll(async () => {
      await database.query(
        `DELETE FROM inventory.stock_threshold_override WHERE id IN ($1, $2)`,
        [overrideId, globalThresholdId],
      );
      await database.query(
        `DELETE FROM inventory.stock_balance WHERE sku_id LIKE $1 OR location_id IN ($2, $3, $4)`,
        [`${runTag}%`, activeLocId, inactiveLocId, emptyLocId],
      );
      await database.query(
        `DELETE FROM inventory.locations WHERE id IN ($1, $2, $3)`,
        [activeLocId, inactiveLocId, emptyLocId],
      );
    });

    it('expone H01/H02 por HTTP contra PostgreSQL 17 con autorización y paginación reales', async () => {
      const previousIssuer = process.env.G7_JWT_ISSUER;
      let app: INestApplication | undefined;
      process.env.G7_JWT_ISSUER = TEST_ISSUER;
      InventoryAuthGuard.setTrustedPublicKey(TEST_PUBLIC_KEY);
      try {
        const module = await Test.createTestingModule({
          imports: [InventorySvcModule],
        })
          .overrideProvider(InventoryWorkersService)
          .useValue({})
          .compile();
        app = module.createNestApplication();
        app.useGlobalFilters(new ProblemDetailsFilter());
        await app.listen(0, '127.0.0.1');
        const origin = await app.getUrl();
        const token = createCryptographicJwt({
          tipo: 'acceso',
          sub: randomUUID(),
          roles: ['GESTOR_COMERCIAL'],
          scope: '',
          includeAudience: false,
        });
        const alertsPath = '/api/v1/inventario/alertas';
        const locationsPath = '/api/v1/inventario/ubicaciones';

        await request(origin).get(alertsPath).expect(401);
        await request(origin)
          .get(alertsPath)
          .auth(
            createCryptographicJwt({
              tipo: 'acceso',
              sub: randomUUID(),
              roles: [],
              scope: '',
              includeAudience: false,
            }),
            { type: 'bearer' },
          )
          .expect(403);
        await request(origin)
          .get(`${alertsPath}?estado=DISPONIBLE`)
          .auth(token, { type: 'bearer' })
          .expect(400);
        await request(origin)
          .get(
            `${alertsPath}?sku=${encodeURIComponent(skuLow)}&locationId=${activeLocId}&pagina=1&tamanio=1`,
          )
          .auth(token, { type: 'bearer' })
          .expect(200)
          .expect(({ body }) => {
            expect(body.items).toHaveLength(1);
            expect(body.items[0]).toMatchObject({
              sku: skuLow,
              estado: 'STOCK_BAJO',
            });
            expect(body.meta).toMatchObject({
              pagina: 1,
              tamanio: 1,
              total: 1,
            });
          });
        await request(origin)
          .get(`${locationsPath}?pagina=1&tamanio=1&soloActivas=true`)
          .auth(token, { type: 'bearer' })
          .expect(200)
          .expect(({ body }) => {
            expect(body.items).toHaveLength(1);
            expect(body.items[0].active).toBe(true);
            expect(body.meta).toMatchObject({ pagina: 1, tamanio: 1 });
          });
        await request(origin)
          .get(`${locationsPath}?tamanio=101`)
          .auth(token, { type: 'bearer' })
          .expect(400);
      } finally {
        await app?.close();
        InventoryAuthGuard.setTrustedPublicKey(null);
        if (previousIssuer === undefined) delete process.env.G7_JWT_ISSUER;
        else process.env.G7_JWT_ISSUER = previousIssuer;
      }
    }, 30_000);

    it('clasifica alertas correctamente en PostgreSQL real: normal/disponible (sin alerta), stock bajo, agotado y umbral exacto', async () => {
      const res = await dashService.obtenerAlertasInternas({
        locationId: activeLocId,
      });

      const skus = res.items.map((i) => i.sku);
      expect(skus).toContain(skuLow);
      expect(skus).toContain(skuAgotado);
      expect(skus).toContain(skuZeroPhysical);
      expect(skus).toContain(skuExactThreshold);
      expect(skus).not.toContain(skuNormal);
      expect(skus).not.toContain(skuOverride);

      const lowAlert = res.items.find((i) => i.sku === skuLow)!;
      expect(lowAlert.estado).toBe('STOCK_BAJO');
      expect(lowAlert.available).toBe(5);
      expect(lowAlert.targetRoute).toBe(
        `/inventario?sku=${encodeURIComponent(skuLow)}&locationId=${encodeURIComponent(activeLocId)}`,
      );

      const exactAlert = res.items.find((i) => i.sku === skuExactThreshold)!;
      expect(exactAlert.estado).toBe('STOCK_BAJO');
      expect(exactAlert.available).toBe(10);
      expect(exactAlert.umbralEfectivo).toBe(10);
    });

    it('verifica que PostgreSQL calcula available como columna generada (GREATEST(0, on_hand-reserved-blocked)) y clasifica AGOTADO cuando stock físico es cero', async () => {
      // available es GENERATED ALWAYS AS en PostgreSQL — no se puede insertar.
      // Con on_hand=0, reserved=0, blocked=0 → available generado = 0 → AGOTADO.
      // Este test confirma que el valor generado por PG coincide con la clasificación del servicio.
      const generatedRow = await database.query<{ available: number }>(
        `SELECT available FROM inventory.stock_balance
         WHERE sku_id = $1 AND location_id = $2`,
        [skuZeroPhysical, activeLocId],
      );
      expect(generatedRow.rows[0].available).toBe(0);

      const res = await dashService.obtenerAlertasInternas({
        sku: skuZeroPhysical,
        locationId: activeLocId,
      });

      expect(res.items).toHaveLength(1);
      expect(res.items[0].estado).toBe('AGOTADO');
      expect(res.items[0].available).toBe(0);
      expect(res.items[0].targetRoute).toBe(
        `/inventario?sku=${encodeURIComponent(skuZeroPhysical)}&locationId=${encodeURIComponent(activeLocId)}`,
      );
    });

    it('no emite alertas para saldos en ubicaciones inactivas (active=false)', async () => {
      const res = await dashService.obtenerAlertasInternas({
        locationId: inactiveLocId,
      });
      expect(res.items).toHaveLength(0);
      expect(res.meta.total).toBe(0);
    });

    it('pagina alertas H01 entre páginas consecutivas sin duplicados y con meta consistente', async () => {
      const todas = await dashService.obtenerAlertasInternas({
        locationId: activeLocId,
        tamanio: 100,
      });
      expect(todas.meta.total).toBe(4);
      expect(todas.items).toHaveLength(4);

      const tamanio = 2;
      const totalPaginas = Math.ceil(todas.meta.total / tamanio);
      expect(totalPaginas).toBe(2);

      const vistos = new Set<string>();
      for (let pagina = 1; pagina <= totalPaginas; pagina += 1) {
        const res = await dashService.obtenerAlertasInternas({
          locationId: activeLocId,
          pagina,
          tamanio,
        });
        expect(res.meta.pagina).toBe(pagina);
        expect(res.meta.tamanio).toBe(tamanio);
        expect(res.meta.total).toBe(todas.meta.total);
        expect(res.meta.totalPaginas).toBe(totalPaginas);
        expect(res.items).toHaveLength(tamanio);
        for (const item of res.items) {
          expect(vistos.has(item.alertaId)).toBe(false);
          vistos.add(item.alertaId);
        }
      }
      expect(vistos.size).toBe(todas.meta.total);
    });

    it('acepta pagina y tamanio como cadenas decimales válidas en alertas H01', async () => {
      const res = await dashService.obtenerAlertasInternas({
        locationId: activeLocId,
        pagina: '1',
        tamanio: '2',
      });
      expect(res.meta.pagina).toBe(1);
      expect(res.meta.tamanio).toBe(2);
      expect(res.meta.total).toBe(4);
      expect(res.meta.totalPaginas).toBe(2);
      expect(res.items).toHaveLength(2);
    });

    it('filtra alertas H01 por AGOTADO y STOCK_BAJO en PostgreSQL real', async () => {
      const agotados = await dashService.obtenerAlertasInternas({
        locationId: activeLocId,
        estado: 'AGOTADO',
        tamanio: 100,
      });
      expect(agotados.items).toHaveLength(2);
      expect(agotados.items.every((i) => i.estado === 'AGOTADO')).toBe(true);
      expect(agotados.items.map((i) => i.sku).sort()).toEqual(
        [skuAgotado, skuZeroPhysical].sort(),
      );
      expect(agotados.meta.total).toBe(2);

      const bajos = await dashService.obtenerAlertasInternas({
        locationId: activeLocId,
        estado: 'STOCK_BAJO',
        tamanio: 100,
      });
      expect(bajos.items).toHaveLength(2);
      expect(bajos.items.every((i) => i.estado === 'STOCK_BAJO')).toBe(true);
      expect(bajos.items.map((i) => i.sku).sort()).toEqual(
        [skuLow, skuExactThreshold].sort(),
      );
      expect(bajos.meta.total).toBe(2);
    });

    it('rechaza paginación inválida en alertas H01 con 400 VALIDACION', async () => {
      const invalidos: Array<Record<string, unknown>> = [
        { pagina: 0 },
        { pagina: -1 },
        { pagina: 1.5 },
        { pagina: Number.NaN },
        { pagina: Number.POSITIVE_INFINITY },
        { pagina: '1.5' },
        { pagina: 'abc' },
        { tamanio: 0 },
        { tamanio: 101 },
        { tamanio: 1.5 },
        { tamanio: Number.NaN },
        { tamanio: Number.POSITIVE_INFINITY },
        { tamanio: 'abc' },
      ];

      for (const query of invalidos) {
        await expect(
          dashService.obtenerAlertasInternas({
            locationId: activeLocId,
            ...query,
          }),
        ).rejects.toMatchObject({
          problem: { status: 400, code: 'VALIDACION' },
        });
      }
    });

    it('respeta override de umbral por SKU sobre el umbral global en PostgreSQL real', async () => {
      const resSinAlerta = await dashService.obtenerAlertasInternas({
        sku: skuOverride,
        locationId: activeLocId,
      });
      expect(resSinAlerta.items).toHaveLength(0);

      await database.query(
        `UPDATE inventory.stock_threshold_override SET umbral_efectivo = 5 WHERE id = $1`,
        [overrideId],
      );
      const resConAlerta = await dashService.obtenerAlertasInternas({
        sku: skuOverride,
        locationId: activeLocId,
      });
      expect(resConAlerta.items).toHaveLength(1);
      expect(resConAlerta.items[0].estado).toBe('STOCK_BAJO');
      expect(resConAlerta.items[0].umbralEfectivo).toBe(5);
    });

    it('devuelve total 0 y lista vacía ante ausencia de registros coincidentes', async () => {
      const res = await dashService.obtenerAlertasInternas({
        sku: `NON-EXISTENT-SKU-${randomUUID()}`,
      });
      expect(res.items).toEqual([]);
      expect(res.meta.total).toBe(0);
    });

    it('rechaza filtros inválidos en alertas con 400 VALIDACION', async () => {
      await expect(
        dashService.obtenerAlertasInternas({ estado: 'DISPONIBLE' }),
      ).rejects.toMatchObject({
        problem: { status: 400, code: 'VALIDACION' },
      });
      await expect(
        dashService.obtenerAlertasInternas({ estado: 'DESCONOCIDO' }),
      ).rejects.toMatchObject({
        problem: { status: 400, code: 'VALIDACION' },
      });
      await expect(
        dashService.obtenerAlertasInternas({
          filtroInexistente: 'test',
        } as any),
      ).rejects.toMatchObject({
        problem: { status: 400, code: 'VALIDACION' },
      });
    });

    it('devuelve ubicaciones autoritativas con paginación consistente (REPEATABLE READ) e incluye ubicaciones sin stock', async () => {
      const pag1 = await dashService.obtenerUbicacionesInternas({
        pagina: 1,
        tamanio: 1,
      });
      expect(pag1.items).toHaveLength(1);
      expect(pag1.meta.pagina).toBe(1);
      expect(pag1.meta.tamanio).toBe(1);
      expect(pag1.meta.total).toBeGreaterThanOrEqual(3);
      expect(pag1.meta.totalPaginas).toBeGreaterThanOrEqual(3);

      const pag2 = await dashService.obtenerUbicacionesInternas({
        pagina: 2,
        tamanio: 1,
      });
      expect(pag2.items).toHaveLength(1);
      expect(pag2.meta.pagina).toBe(2);
      expect(pag2.items[0].id).not.toBe(pag1.items[0].id);

      const todas = await dashService.obtenerUbicacionesInternas({
        tamanio: 100,
      });
      const emptyFound = todas.items.find((u) => u.id === emptyLocId);
      expect(emptyFound).toBeDefined();
      expect(emptyFound?.name).toBe(`Empty Location ${runTag}`);
    });

    it('respeta la semántica exacta de soloActivas en PostgreSQL real: true = solo activas, false o ausente = todas', async () => {
      const activas = await dashService.obtenerUbicacionesInternas({
        soloActivas: true,
        tamanio: 100,
      });
      expect(activas.items.every((u) => u.active === true)).toBe(true);
      expect(activas.items.find((u) => u.id === inactiveLocId)).toBeUndefined();
      expect(activas.items.find((u) => u.id === activeLocId)).toBeDefined();

      const todasFalse = await dashService.obtenerUbicacionesInternas({
        soloActivas: false,
        tamanio: 100,
      });
      expect(
        todasFalse.items.find((u) => u.id === inactiveLocId),
      ).toBeDefined();
      expect(todasFalse.items.find((u) => u.id === activeLocId)).toBeDefined();

      const todasAusente = await dashService.obtenerUbicacionesInternas({
        tamanio: 100,
      });
      expect(
        todasAusente.items.find((u) => u.id === inactiveLocId),
      ).toBeDefined();
      expect(
        todasAusente.items.find((u) => u.id === activeLocId),
      ).toBeDefined();
      expect(todasAusente.meta.total).toBe(todasFalse.meta.total);
    });

    it('rechaza parámetros de consulta inválidos en ubicaciones con 400 VALIDACION', async () => {
      await expect(
        dashService.obtenerUbicacionesInternas({ pagina: 0 }),
      ).rejects.toMatchObject({
        problem: { status: 400, code: 'VALIDACION' },
      });
      await expect(
        dashService.obtenerUbicacionesInternas({ tamanio: 101 }),
      ).rejects.toMatchObject({
        problem: { status: 400, code: 'VALIDACION' },
      });
      await expect(
        dashService.obtenerUbicacionesInternas({
          filtroDesconocido: 'x',
        } as any),
      ).rejects.toMatchObject({
        problem: { status: 400, code: 'VALIDACION' },
      });
      await expect(
        dashService.obtenerUbicacionesInternas({
          soloActivas: 'no-booleano' as any,
        }),
      ).rejects.toMatchObject({
        problem: { status: 400, code: 'VALIDACION' },
      });
    });
  });
});

async function waitForContainer(
  container: string,
  command: string,
): Promise<void> {
  const started = Date.now();
  let lastError: unknown;
  while (Date.now() - started < 60_000) {
    try {
      execFileSync('docker', ['exec', container, ...command.split(' ')], {
        stdio: 'ignore',
        timeout: 5000,
      });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error(`Timeout esperando ${container}: ${String(lastError)}`);
}
