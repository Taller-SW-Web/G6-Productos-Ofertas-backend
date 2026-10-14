import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import amqp from 'amqplib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DatabaseService } from '../src/database/database.service.js';
import { IdempotencyService } from '../src/idempotency/idempotency.service.js';
import { KardexService } from '../src/kardex/kardex.service.js';
import { OutboxService } from '../src/outbox/outbox.service.js';
import { OutboxPublisherService } from '../src/outbox/outbox-publisher.service.js';
import { ReservationExpirationService } from '../src/reservations/reservation-expiration.service.js';
import { ReservationsService } from '../src/reservations/reservations.service.js';
import { InventoryWorkersService } from '../src/workers/inventory-workers.service.js';
import { DrizzleCommercialRoutesRepository } from '../src/repositories/drizzle/drizzle-commercial-routes.repository.js';
import { DrizzleKardexRepository } from '../src/repositories/drizzle/drizzle-kardex.repository.js';
import { DrizzleLocationsRepository } from '../src/repositories/drizzle/drizzle-locations.repository.js';
import { DrizzleOperationsRepository } from '../src/repositories/drizzle/drizzle-operations.repository.js';
import { DrizzleOutboxRepository } from '../src/repositories/drizzle/drizzle-outbox.repository.js';
import { DrizzleReservationsRepository } from '../src/repositories/drizzle/drizzle-reservations.repository.js';
import { DrizzleStockBalanceRepository } from '../src/repositories/drizzle/drizzle-stock-balance.repository.js';

const enabled = Boolean(process.env.INVENTORY_REAL_INTEGRATION === '1');
const suite = enabled ? describe : describe.skip;
const docker = promisify(execFile);

suite('inventory-svc integración real PostgreSQL + RabbitMQ', () => {
  const database = new DatabaseService();
  const reservationsRepo = new DrizzleReservationsRepository(database);
  const stockRepo = new DrizzleStockBalanceRepository(database);
  const operationsRepo = new DrizzleOperationsRepository(database);
  const outboxRepo = new DrizzleOutboxRepository(database);
  const outboxService = new OutboxService(outboxRepo);
  const reservations = new ReservationsService(
    database,
    new IdempotencyService(),
    new KardexService(new DrizzleKardexRepository(database)),
    outboxService,
    reservationsRepo,
    stockRepo,
    operationsRepo,
    new DrizzleLocationsRepository(database),
    new DrizzleCommercialRoutesRepository(database),
  );
  const expiration = new ReservationExpirationService(
    database,
    reservations,
    reservationsRepo,
  );
  let broker: amqp.ChannelModel;
  let brokerChannel: amqp.Channel;
  let locationId: string;
  const exchangeEvents = 'po.events.x';
  const exchangeResults = 'po.results.x';
  const queue = `inventory-it-${randomUUID()}`;
  const pgUrl = process.env.DATABASE_URL!;
  const rabbitUrl = process.env.RABBITMQ_URL!;

  beforeAll(async () => {
    if (!pgUrl || !rabbitUrl)
      throw new Error('Faltan URLs aisladas de integración');
    await database.onModuleInit();
    broker = await amqp.connect(rabbitUrl);
    brokerChannel = await broker.createChannel();
    await brokerChannel.assertExchange(exchangeEvents, 'topic', {
      durable: true,
    });
    await brokerChannel.assertExchange(exchangeResults, 'topic', {
      durable: true,
    });
    await brokerChannel.assertQueue(queue, {
      durable: false,
      autoDelete: true,
    });
    await brokerChannel.bindQueue(queue, exchangeEvents, 'inventory.#');
    await brokerChannel.bindQueue(queue, exchangeResults, 'inventory.#');
    const location = await database.query<{ id: string }>(
      `INSERT INTO inventory.locations(code,name,type) VALUES ($1,$2,'TIENDA') RETURNING id`,
      [`it-${randomUUID()}`, 'Inventory integration'],
    );
    locationId = location.rows[0].id;
    process.env.INVENTORY_WORKER_INTERVAL_MS = '250';
    process.env.INVENTORY_WORKER_BATCH_SIZE = '10';
    process.env.RESERVATION_TTL_SECONDS = '30';
  }, 30_000);

  afterAll(async () => {
    await brokerChannel?.close().catch(() => undefined);
    await broker?.close().catch(() => undefined);
    await database.onModuleDestroy();
  });

  async function seedStock(sku = `sku-${randomUUID()}`, qty = 20) {
    await database.query(
      `INSERT INTO inventory.stock_balance(sku_id,location_id,on_hand,reserved,blocked) VALUES($1,$2,$3,0,0)`,
      [sku, locationId, qty],
    );
    return sku;
  }

  async function reserve(sku: string, qty = 2, order = `PED-${randomUUID()}`) {
    const accepted = await reservations.solicitarReserva(
      {
        order_id: order,
        operation_id: randomUUID(),
        channel_id: 'VENTAS',
        lines: [{ sku, quantity: qty, location_id: locationId }],
      },
      undefined,
      `idem-${randomUUID()}`,
      'modulo-ventas',
    );
    const row = await database.query<{ reservation_id: string }>(
      `SELECT reservation_id FROM inventory.reservations WHERE operation_id=$1`,
      [accepted.operation_id],
    );
    return { accepted, reservationId: row.rows[0].reservation_id, order };
  }

  async function publishRecord(
    eventType: string,
    kind: 'event' | 'result' = 'event',
  ) {
    const eventId = randomUUID();
    const messageId = randomUUID();
    await database.transaction((tx) =>
      outboxRepo.enqueue(tx, {
        event_id: eventId,
        event_type: eventType,
        aggregate_type: 'integration-test',
        aggregate_id: eventId,
        payload: { message_id: messageId, kind, name: eventType, test: true },
      }),
    );
    const row = await database.query<{ id: string }>(
      `SELECT id FROM inventory.outbox WHERE event_id=$1`,
      [eventId],
    );
    return { eventId, messageId, id: row.rows[0].id };
  }

  it('ejecuta Drizzle y acredita UPDATE RETURNING para cero y una fila', async () => {
    const sku = await seedStock();
    const existing = await database.transaction((tx) =>
      stockRepo.updateStock(tx, sku, locationId, {
        reserved: 1,
        stock_version: 1,
      }),
    );
    const missing = await database.transaction((tx) =>
      stockRepo.updateStock(tx, `missing-${randomUUID()}`, locationId, {
        reserved: 1,
        stock_version: 1,
      }),
    );
    const rows = await stockRepo.findBySkus([sku], locationId);
    expect(existing).toBe(1);
    expect(missing).toBe(0);
    expect(rows[0].reserved).toBe(1);

    const reservationId = randomUUID();
    const reservationInsert = await database.query<{ id: string }>(
      `INSERT INTO inventory.reservations(reservation_id,expires_at,idempotency_key,order_id) VALUES($1,now()+interval '1 minute',$2,$3) RETURNING id`,
      [reservationId, `status-${randomUUID()}`, `PED-${randomUUID()}`],
    );
    expect(
      await database.transaction((tx) =>
        reservationsRepo.updateStatus(
          tx,
          reservationInsert.rows[0].id,
          'LIBERADA',
        ),
      ),
    ).toBe(1);
    expect(
      await database.transaction((tx) =>
        reservationsRepo.updateStatus(tx, randomUUID(), 'LIBERADA'),
      ),
    ).toBe(0);
  });

  it('hace rollback completo ante falla SQL intermedia tras saldo y outbox', async () => {
    const sku = await seedStock();
    const rollbackReservationId = randomUUID();
    const rollbackKey = `rollback-${randomUUID()}`;
    const initialOutbox = await database.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM inventory.outbox',
    );
    await expect(
      database.transaction(async (tx) => {
        const affected = await stockRepo.updateStock(tx, sku, locationId, {
          reserved: 3,
          stock_version: 1,
        });
        expect(affected).toBe(1);
        await outboxRepo.enqueue(tx, {
          event_id: randomUUID(),
          event_type: 'inventory.test.rollback',
          aggregate_type: 'test',
          aggregate_id: sku,
          payload: { message_id: randomUUID(), kind: 'event' },
        });
        const inserted = await reservationsRepo.create(tx, {
          reservation_id: rollbackReservationId,
          status: 'ACTIVA',
          expires_at: new Date(Date.now() + 60_000).toISOString(),
          idempotency_key: rollbackKey,
          intention: 'reservar',
        });
        await reservationsRepo.updateStatus(tx, inserted, 'LIBERADA');
        await new DrizzleKardexRepository(database).createMovement(tx, {
          sku_id: sku,
          location_id: locationId,
          operation_type: 'LIBERACION',
          reservation_id: rollbackReservationId,
          quantity: -1,
          on_hand_before: 20,
          on_hand_after: 20,
          reserved_before: 1,
          reserved_after: 0,
          blocked_before: 0,
          blocked_after: 0,
          stock_version: 1,
        });
        await tx.query(
          'INSERT INTO inventory.table_does_not_exist(id) VALUES ($1)',
          [randomUUID()],
        );
      }),
    ).rejects.toThrow();
    const stock = await stockRepo.findBySkus([sku], locationId);
    const afterOutbox = await database.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM inventory.outbox',
    );
    const rollbackReservation = await database.query<{
      status: string;
      kardex: string;
    }>(
      `SELECT r.status,(SELECT count(*)::text FROM inventory.kardex k WHERE k.reservation_id=r.reservation_id) AS kardex FROM inventory.reservations r WHERE r.reservation_id=$1`,
      [rollbackReservationId],
    );
    const rollbackKardex = await database.query(
      `SELECT id FROM inventory.kardex WHERE reservation_id=$1`,
      [rollbackReservationId],
    );
    expect(stock[0].reserved).toBe(0);
    expect(stock[0].stock_version).toBe(0);
    expect(afterOutbox.rows[0].count).toBe(initialOutbox.rows[0].count);
    expect(rollbackReservation.rowCount).toBe(0);
    expect(rollbackKardex.rowCount).toBe(0);
  });

  it('rechaza order_id incorrecto en confirmar/liberar sin efectos secundarios', async () => {
    for (const action of ['confirm', 'release'] as const) {
      const sku = await seedStock();
      const { reservationId, order } = await reserve(sku);
      const before = await database.query(
        `SELECT r.status,b.on_hand,b.reserved,(SELECT count(*) FROM inventory.kardex WHERE reservation_id=r.reservation_id) AS kardex,(SELECT count(*) FROM inventory.outbox WHERE aggregate_id=r.reservation_id::text) AS outbox FROM inventory.reservations r JOIN inventory.reservation_lines l ON l.reservation_id=r.id JOIN inventory.stock_balance b ON b.sku_id=l.sku_id AND b.location_id=l.location_id WHERE r.reservation_id=$1`,
        [reservationId],
      );
      const wrong = { order_id: `${order}-wrong`, operation_id: randomUUID() };
      const invoke =
        action === 'confirm'
          ? reservations.confirmarReserva(
              reservationId,
              wrong,
              undefined,
              `idem-${randomUUID()}`,
              'modulo-ventas',
            )
          : reservations.liberarReserva(
              reservationId,
              { ...wrong, reason: 'ANULACION' },
              undefined,
              `idem-${randomUUID()}`,
              'modulo-ventas',
            );
      await expect(invoke).rejects.toThrow();
      const after = await database.query(
        `SELECT r.status,b.on_hand,b.reserved,(SELECT count(*) FROM inventory.kardex WHERE reservation_id=r.reservation_id) AS kardex,(SELECT count(*) FROM inventory.outbox WHERE aggregate_id=r.reservation_id::text) AS outbox FROM inventory.reservations r JOIN inventory.reservation_lines l ON l.reservation_id=r.id JOIN inventory.stock_balance b ON b.sku_id=l.sku_id AND b.location_id=l.location_id WHERE r.reservation_id=$1`,
        [reservationId],
      );
      expect(after.rows[0]).toEqual(before.rows[0]);
    }
  });

  it('confirma o libera concurrentemente una misma reserva solo una vez', async () => {
    for (const action of ['confirm', 'release'] as const) {
      const sku = await seedStock();
      const { reservationId, order } = await reserve(sku, 2);
      const invoke = () =>
        action === 'confirm'
          ? reservations.confirmarReserva(
              reservationId,
              { order_id: order, operation_id: randomUUID() },
              undefined,
              `idem-${randomUUID()}`,
              'modulo-ventas',
            )
          : reservations.liberarReserva(
              reservationId,
              {
                order_id: order,
                operation_id: randomUUID(),
                reason: 'ANULACION',
              },
              undefined,
              `idem-${randomUUID()}`,
              'modulo-ventas',
            );
      const results = await Promise.allSettled([invoke(), invoke()]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const row = await database.query<{
        status: string;
        on_hand: number;
        reserved: number;
      }>(
        `SELECT r.status,b.on_hand,b.reserved FROM inventory.reservations r JOIN inventory.reservation_lines l ON l.reservation_id=r.id JOIN inventory.stock_balance b ON b.sku_id=l.sku_id AND b.location_id=l.location_id WHERE r.reservation_id=$1`,
        [reservationId],
      );
      expect(row.rows[0].status).toBe(
        action === 'confirm' ? 'CONSUMIDA' : 'LIBERADA',
      );
      expect(row.rows[0].on_hand).toBe(action === 'confirm' ? 18 : 20);
      expect(row.rows[0].reserved).toBe(0);
    }
  });

  it('serializa reservas concurrentes e idempotencia concurrente en PostgreSQL', async () => {
    const sku = await seedStock(`concurrent-stock-${randomUUID()}`, 5);
    const req = () => ({
      order_id: `PED-${randomUUID()}`,
      operation_id: randomUUID(),
      channel_id: 'VENTAS' as const,
      lines: [{ sku, quantity: 4, location_id: locationId }],
    });
    const results = await Promise.all(
      [req(), req()].map((dto) =>
        reservations.solicitarReserva(
          dto,
          undefined,
          `idem-${randomUUID()}`,
          'modulo-ventas',
        ),
      ),
    );
    const balance = await stockRepo.findBySkus([sku], locationId);
    expect(balance[0].reserved).toBe(4);
    expect(
      await database.query(
        `SELECT id FROM inventory.reservations WHERE reservation_id IN (SELECT reservation_id FROM inventory.inventory_operations WHERE operation_id = ANY($1::uuid[]))`,
        [results.map((r) => r.operation_id)],
      ),
    ).toMatchObject({ rowCount: 1 });

    const idemSku = await seedStock(`idempotent-stock-${randomUUID()}`, 100);
    const idemDto = {
      order_id: `PED-${randomUUID()}`,
      operation_id: randomUUID(),
      channel_id: 'VENTAS' as const,
      lines: [{ sku: idemSku, quantity: 1, location_id: locationId }],
    };
    const key = `idem-${randomUUID()}`;
    const replay = await Promise.all([
      reservations.solicitarReserva(idemDto, undefined, key, 'modulo-ventas'),
      reservations.solicitarReserva(idemDto, undefined, key, 'modulo-ventas'),
    ]);
    expect(replay.map((r) => r.operation_id)).toEqual([
      idemDto.operation_id,
      idemDto.operation_id,
    ]);
    const ops = await database.query(
      `SELECT id FROM inventory.inventory_operations WHERE operation_id=$1`,
      [idemDto.operation_id],
    );
    expect(ops.rowCount).toBe(1);
  });

  it('expira automáticamente desde el worker Nest sin endpoint ni llamada manual', async () => {
    const sku = await seedStock();
    const { reservationId } = await reserve(sku, 3);
    await database.query(
      `UPDATE inventory.reservations SET expires_at=now()-interval '1 second' WHERE reservation_id=$1`,
      [reservationId],
    );
    const publisher = new OutboxPublisherService(database, outboxRepo);
    const workers = new InventoryWorkersService(expiration, publisher);
    workers.onModuleInit();
    try {
      await viWaitFor(async () => {
        const result = await database.query<{ status: string }>(
          `SELECT status FROM inventory.reservations WHERE reservation_id=$1`,
          [reservationId],
        );
        expect(result.rows[0].status).toBe('EXPIRADA');
      }, 10_000);
    } finally {
      await workers.onModuleDestroy();
    }
    const final = await database.query<{
      on_hand: number;
      reserved: number;
      kardex: string;
      events: string;
    }>(
      `SELECT b.on_hand,b.reserved,(SELECT count(*)::text FROM inventory.kardex WHERE reservation_id=r.reservation_id AND operation_type='EXPIRACION') AS kardex,(SELECT count(*)::text FROM inventory.outbox WHERE aggregate_id=r.reservation_id::text AND event_type='inventory.reservation.expired') AS events FROM inventory.reservations r JOIN inventory.reservation_lines l ON l.reservation_id=r.id JOIN inventory.stock_balance b ON b.sku_id=l.sku_id AND b.location_id=l.location_id WHERE r.reservation_id=$1`,
      [reservationId],
    );
    expect(final.rows[0]).toMatchObject({
      on_hand: 20,
      reserved: 0,
      kardex: '1',
      events: '1',
    });
  });

  it('usa publisher confirm, marca solo mensaje enrutado y deja basic.return como PENDING', async () => {
    const publisher = new OutboxPublisherService(database, outboxRepo);
    const routed = await publishRecord('inventory.integration.routed');
    const unrouted = await publishRecord(
      `integration.unrouted.${randomUUID()}`,
    );
    const result = await publisher.dispatchPending(100);
    expect(result.dispatched).toBeGreaterThanOrEqual(1);
    const statuses = await database.query<{ id: string; status: string }>(
      `SELECT id,status FROM inventory.outbox WHERE id=ANY($1::uuid[])`,
      [[routed.id, unrouted.id]],
    );
    expect(statuses.rows.find((r) => r.id === routed.id)?.status).toBe(
      'PUBLISHED',
    );
    expect(statuses.rows.find((r) => r.id === unrouted.id)?.status).toBe(
      'PENDING',
    );
    await database.query(`DELETE FROM inventory.outbox WHERE id=$1`, [
      unrouted.id,
    ]);
    const message = await brokerChannel.get(queue);
    expect(message?.properties.messageId).toBeDefined();
    if (message) brokerChannel.ack(message);
  });

  it('coordina dos dispatchers y conserva evento al detener/reiniciar RabbitMQ', async () => {
    const a = await publishRecord('inventory.integration.concurrent.a');
    const b = await publishRecord('inventory.integration.concurrent.b');
    const one = new OutboxPublisherService(database, outboxRepo);
    const two = new OutboxPublisherService(database, outboxRepo);
    const [ra, rb] = await Promise.all([
      one.dispatchPending(1),
      two.dispatchPending(1),
    ]);
    const concurrentStatuses = await database.query<{
      id: string;
      status: string;
    }>(`SELECT id,status FROM inventory.outbox WHERE id=ANY($1::uuid[])`, [
      [a.id, b.id],
    ]);
    expect(
      concurrentStatuses.rows.every((row) => row.status === 'PUBLISHED'),
    ).toBe(true);
    expect(ra.dispatched + rb.dispatched).toBe(2);

    const pending = await publishRecord('inventory.integration.recovery');
    await docker('docker', ['stop', 'inventory-it-rabbit'], {
      timeout: 15_000,
    });
    try {
      const downResult = await new OutboxPublisherService(
        database,
        outboxRepo,
      ).dispatchPending(10);
      expect(downResult.skipped).toBe(true);
      expect(
        (
          await database.query<{ status: string }>(
            `SELECT status FROM inventory.outbox WHERE id=$1`,
            [pending.id],
          )
        ).rows[0].status,
      ).toBe('PENDING');
    } finally {
      await docker('docker', ['start', 'inventory-it-rabbit'], {
        timeout: 15_000,
      });
    }

    let recoveredBroker: amqp.ChannelModel | undefined;
    await viWaitFor(async () => {
      recoveredBroker = await amqp.connect(rabbitUrl);
    }, 20_000);
    broker = recoveredBroker!;
    const recoveredChannel = await broker.createChannel();
    brokerChannel = recoveredChannel;
    await recoveredChannel.assertExchange(exchangeEvents, 'topic', {
      durable: true,
    });
    await recoveredChannel.assertQueue(queue, {
      durable: false,
      autoDelete: true,
    });
    await recoveredChannel.bindQueue(queue, exchangeEvents, 'inventory.#');
    const recovered = await new OutboxPublisherService(
      database,
      outboxRepo,
    ).dispatchPending(10);
    expect(recovered.dispatched).toBeGreaterThanOrEqual(1);
    expect(
      (
        await database.query<{ status: string }>(
          `SELECT status FROM inventory.outbox WHERE id=$1`,
          [pending.id],
        )
      ).rows[0].status,
    ).toBe('PUBLISHED');
    let recoveredMessageId: string | undefined;
    for (;;) {
      const message = await recoveredChannel.get(queue);
      if (!message) break;
      if (message.properties.messageId === pending.messageId) {
        recoveredMessageId = message.properties.messageId;
      }
      recoveredChannel.ack(message);
    }
    expect(recoveredMessageId).toBe(pending.messageId);
    expect([a.id, b.id]).toHaveLength(2);
  }, 30_000);

  it('simula caída tras confirmación antes de UPDATE y reintenta con el mismo message_id', async () => {
    const pending = await publishRecord('inventory.integration.crash');
    const crashingRepo = {
      findPendingForUpdateSkipLocked:
        outboxRepo.findPendingForUpdateSkipLocked.bind(outboxRepo),
      markAsPublished: async () => {
        throw new Error('fallo simulado tras confirm');
      },
    } as unknown as DrizzleOutboxRepository;
    const failed = await new OutboxPublisherService(
      database,
      crashingRepo,
    ).dispatchPending(10);
    expect(failed.failed).toBeGreaterThanOrEqual(1);
    expect(
      (
        await database.query<{ status: string }>(
          `SELECT status FROM inventory.outbox WHERE id=$1`,
          [pending.id],
        )
      ).rows[0].status,
    ).toBe('PENDING');
    await brokerChannel.purgeQueue(queue);
    await new OutboxPublisherService(database, outboxRepo).dispatchPending(10);
    let found = false;
    for (;;) {
      const msg = await brokerChannel.get(queue);
      if (!msg) break;
      if (msg.properties.messageId === pending.messageId) found = true;
      brokerChannel.ack(msg);
    }
    expect(found).toBe(true);
  });
});

async function viWaitFor(
  assertion: () => Promise<void>,
  timeout: number,
): Promise<void> {
  const end = Date.now() + timeout;
  let lastError: unknown;
  while (Date.now() < end) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw lastError ?? new Error('Timeout esperando condición de integración');
}
