import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import amqp from 'amqplib';
import pg from 'pg';
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
const previousDatabaseUrl = process.env.DATABASE_URL;
const previousRabbitMqUrl = process.env.RABBITMQ_URL;

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
  const runId = randomUUID().replaceAll('-', '').slice(0, 12);
  const dockerLabel = `inventory.integration.run=${runId}`;
  const networkName = `inventory-it-net-${runId}`;
  const pgContainer = `inventory-it-pg-${runId}`;
  const rabbitContainer = `inventory-it-rabbit-${runId}`;
  let pgUrl: string;
  let rabbitUrl: string;

  function docker(args: string[], input?: string): string {
    return execFileSync('docker', args, {
      encoding: 'utf8',
      input,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 120_000,
    }).trim();
  }

  function cleanupOwnedResources(): void {
    for (const container of [pgContainer, rabbitContainer]) {
      try {
        const labels = JSON.parse(
          docker(['inspect', '--format', '{{json .Config.Labels}}', container]),
        ) as Record<string, string>;
        if (labels['inventory.integration.run'] === runId) {
          docker(['rm', '-f', '-v', container]);
        }
      } catch {
        // El recurso no llegó a crearse o ya fue retirado.
      }
    }
    try {
      const labels = JSON.parse(
        docker([
          'network',
          'inspect',
          '--format',
          '{{json .Labels}}',
          networkName,
        ]),
      ) as Record<string, string>;
      if (labels['inventory.integration.run'] === runId) {
        docker(['network', 'rm', networkName]);
      }
    } catch {
      // La red no llegó a crearse o Docker ya la retiró.
    }
  }

  beforeAll(async () => {
    const password = randomBytes(24).toString('hex');
    const rabbitPassword = randomBytes(24).toString('hex');
    try {
      docker(['network', 'create', '--label', dockerLabel, networkName]);
      docker([
        'run',
        '-d',
        '--name',
        pgContainer,
        '--label',
        dockerLabel,
        '--network',
        networkName,
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
      docker([
        'run',
        '-d',
        '--name',
        rabbitContainer,
        '--label',
        dockerLabel,
        '--network',
        networkName,
        '-p',
        '127.0.0.1::5672',
        '-e',
        'RABBITMQ_DEFAULT_USER=inventory_test',
        '-e',
        `RABBITMQ_DEFAULT_PASS=${rabbitPassword}`,
        'rabbitmq:3.13-management-alpine',
      ]);
      const pgPort = docker(['port', pgContainer, '5432/tcp'])
        .split(':')
        .at(-1);
      const rabbitPort = docker(['port', rabbitContainer, '5672/tcp'])
        .split(':')
        .at(-1);
      if (!pgPort || !rabbitPort)
        throw new Error('Docker no asignó puertos loopback.');
      pgUrl = `postgresql://inventory_test:${password}@127.0.0.1:${pgPort}/inventory_it?sslmode=disable`;
      rabbitUrl = `amqp://inventory_test:${rabbitPassword}@127.0.0.1:${rabbitPort}/`;

      await waitForContainer(
        pgContainer,
        'pg_isready -U inventory_test -d inventory_it',
      );
      await waitForContainer(
        rabbitContainer,
        'rabbitmq-diagnostics -q check_running',
      );
      const docsRoot = new URL(
        '../../../../docs/datos/inventory-svc/',
        import.meta.url,
      );
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
      docker(
        [
          'exec',
          '-i',
          pgContainer,
          'psql',
          '-v',
          'ON_ERROR_STOP=1',
          '-U',
          'inventory_test',
          '-d',
          'inventory_it',
        ],
        initial,
      );
      docker(
        [
          'exec',
          '-i',
          pgContainer,
          'psql',
          '-v',
          'ON_ERROR_STOP=1',
          '-U',
          'inventory_test',
          '-d',
          'inventory_it',
        ],
        `BEGIN;\n${incremental}\nCOMMIT;`,
      );
      docker([
        'exec',
        rabbitContainer,
        'rabbitmqctl',
        'add_vhost',
        '/inventory-it',
      ]);
      docker([
        'exec',
        rabbitContainer,
        'rabbitmqctl',
        'set_permissions',
        '-p',
        '/inventory-it',
        'inventory_test',
        '.*',
        '.*',
        '.*',
      ]);
      rabbitUrl = `amqp://inventory_test:${rabbitPassword}@127.0.0.1:${rabbitPort}/%2Finventory-it`;
      process.env.DATABASE_URL = pgUrl;
      process.env.RABBITMQ_URL = rabbitUrl;
      await database.onModuleInit();
      broker = await amqp.connect(rabbitUrl);
      brokerChannel = await broker.createChannel();
    } catch (error) {
      cleanupOwnedResources();
      throw error;
    }
    await brokerChannel.assertExchange(exchangeEvents, 'topic', {
      durable: true,
    });
    await brokerChannel.assertExchange(exchangeResults, 'topic', {
      durable: true,
    });
    await brokerChannel.assertQueue(queue, {
      durable: false,
      exclusive: true,
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
  }, 120_000);

  afterAll(async () => {
    await brokerChannel?.close().catch(() => undefined);
    await broker?.close().catch(() => undefined);
    await database.onModuleDestroy();
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    if (previousRabbitMqUrl === undefined) delete process.env.RABBITMQ_URL;
    else process.env.RABBITMQ_URL = previousRabbitMqUrl;
    cleanupOwnedResources();
  }, 30_000);

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
    expect(replay[1]).toEqual(replay[0]);
    expect(
      await reservations.solicitarReserva(
        idemDto,
        undefined,
        key,
        'modulo-ventas',
      ),
    ).toEqual(replay[0]);
    const ops = await database.query(
      `SELECT id FROM inventory.inventory_operations WHERE operation_id=$1`,
      [idemDto.operation_id],
    );
    expect(ops.rowCount).toBe(1);

    const rejectedSku = await seedStock(`rejected-stock-${randomUUID()}`, 1);
    const rejectedDto = {
      order_id: `PED-${randomUUID()}`,
      operation_id: randomUUID(),
      channel_id: 'VENTAS' as const,
      lines: [{ sku: rejectedSku, quantity: 2, location_id: locationId }],
    };
    const rejectedKey = `idem-${randomUUID()}`;
    const acceptedCommand = await reservations.solicitarReserva(
      rejectedDto,
      undefined,
      rejectedKey,
      'modulo-ventas',
    );
    expect(acceptedCommand.status).toBe('ACCEPTED');
    expect(
      await reservations.solicitarReserva(
        rejectedDto,
        undefined,
        rejectedKey,
        'modulo-ventas',
      ),
    ).toEqual(acceptedCommand);
    const rejectedOperation = await database.query<{
      status: string;
      result_code: string;
      result_payload: unknown;
    }>(
      `SELECT status,result_code,result_payload FROM inventory.inventory_operations WHERE operation_id=$1`,
      [rejectedDto.operation_id],
    );
    expect(rejectedOperation.rows[0]).toMatchObject({
      status: 'RECHAZADO',
      result_code: 'STOCK_INSUFICIENTE',
      result_payload: acceptedCommand,
    });
  });

  it('reproduce exactamente el replay concurrente durable al confirmar y liberar', async () => {
    for (const action of ['confirm', 'release'] as const) {
      const sku = await seedStock();
      const { reservationId, order } = await reserve(sku, 2);
      const request = {
        order_id: order,
        operation_id: randomUUID(),
        ...(action === 'release' ? { reason: 'ANULACION' as const } : {}),
      };
      const key = `idem-${randomUUID()}`;
      const invoke = () =>
        action === 'confirm'
          ? reservations.confirmarReserva(
              reservationId,
              request,
              undefined,
              key,
              'modulo-ventas',
            )
          : reservations.liberarReserva(
              reservationId,
              request,
              undefined,
              key,
              'modulo-ventas',
            );
      const [first, replay] = await Promise.all([invoke(), invoke()]);
      expect(replay).toEqual(first);
      expect(await invoke()).toEqual(first);
      const persisted = await database.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM inventory.inventory_operations WHERE operation_id=$1`,
        [request.operation_id],
      );
      expect(persisted.rows[0].count).toBe('1');
    }
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

  it('serializa liberación y expiración concurrentes con un único efecto de negocio', async () => {
    const sku = await seedStock();
    const { reservationId, order } = await reserve(sku, 3);
    const lockHolder = new pg.Client({
      connectionString: process.env.DATABASE_URL,
    });
    await lockHolder.connect();
    try {
      await lockHolder.query('BEGIN');
      await lockHolder.query(
        `SELECT id FROM inventory.reservations WHERE reservation_id=$1 FOR UPDATE`,
        [reservationId],
      );
      const release = reservations.liberarReserva(
        reservationId,
        {
          order_id: order,
          operation_id: randomUUID(),
          reason: 'PAGO_NO_COMPLETADO',
        },
        undefined,
        `idem-${randomUUID()}`,
        'modulo-ventas',
      );
      await viWaitFor(async () => {
        const waiting = await database.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM pg_stat_activity WHERE wait_event_type='Lock' AND query ILIKE '%FROM inventory.reservations%' AND query ILIKE '%FOR UPDATE%'`,
        );
        expect(Number(waiting.rows[0].count)).toBeGreaterThan(0);
      }, 5000);
      await lockHolder.query(
        `UPDATE inventory.reservations SET expires_at=now()-interval '1 second' WHERE reservation_id=$1`,
        [reservationId],
      );
      // El worker concurrente omite la fila mientras el otro tx mantiene su
      // lock; al liberarlo, el flujo de release debe revalidar expires_at.
      await lockHolder.query('COMMIT');
      const expirationRun = expiration.expirarReservasVencidas(10);
      await expect(release).rejects.toThrow();
      await expirationRun;
    } finally {
      await lockHolder.query('ROLLBACK').catch(() => undefined);
      await lockHolder.end();
    }
    const state = await database.query<{
      status: string;
      on_hand: number;
      reserved: number;
      movements: string;
      released_events: string;
      expired_events: string;
    }>(
      `SELECT r.status,b.on_hand,b.reserved,(SELECT count(*)::text FROM inventory.kardex WHERE reservation_id=r.reservation_id AND operation_type IN ('LIBERACION','EXPIRACION')) AS movements,(SELECT count(*)::text FROM inventory.outbox WHERE aggregate_id=r.reservation_id::text AND event_type='inventory.reservation.released') AS released_events,(SELECT count(*)::text FROM inventory.outbox WHERE aggregate_id=r.reservation_id::text AND event_type='inventory.reservation.expired') AS expired_events FROM inventory.reservations r JOIN inventory.reservation_lines l ON l.reservation_id=r.id JOIN inventory.stock_balance b ON b.sku_id=l.sku_id AND b.location_id=l.location_id WHERE r.reservation_id=$1`,
      [reservationId],
    );
    expect(state.rows[0].status).toMatch(/^(LIBERADA|EXPIRADA)$/);
    expect(state.rows[0]).toMatchObject({
      on_hand: 20,
      reserved: 0,
      movements: '1',
    });
    expect(
      Number(state.rows[0].released_events) +
        Number(state.rows[0].expired_events),
    ).toBe(1);
    expect(state.rows[0].status).toBe('EXPIRADA');
  });

  it('usa publisher confirm, marca solo mensaje enrutado y deja basic.return como PENDING', async () => {
    await database.query('DELETE FROM inventory.outbox');
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

  it('coordina dos dispatchers y recupera el evento pendiente tras indisponibilidad del broker', async () => {
    await database.query('DELETE FROM inventory.outbox');
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
    const ownedLabels = docker([
      'inspect',
      '--format',
      '{{json .Config.Labels}}',
      rabbitContainer,
    ]);
    expect(JSON.parse(ownedLabels)['inventory.integration.run']).toBe(runId);
    // Pausa únicamente el broker efímero mientras el dispatcher intenta
    // conectarse; el proceso/volumen de RabbitMQ permanece bajo este test.
    await brokerChannel.close();
    await broker.close();
    docker(['pause', rabbitContainer]);
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
      docker(['unpause', rabbitContainer]);
    }

    // El dispatcher de aplicación se recrea y retoma la fila durable tras
    // recuperarse el broker; RabbitMQ sigue siendo el recurso efímero propio.
    broker = await amqp.connect(rabbitUrl);
    brokerChannel = await broker.createChannel();
    await brokerChannel.assertQueue(queue, {
      durable: false,
      exclusive: true,
      autoDelete: true,
    });
    await brokerChannel.bindQueue(queue, exchangeEvents, 'inventory.#');
    await brokerChannel.bindQueue(queue, exchangeResults, 'inventory.#');
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
      const message = await brokerChannel.get(queue);
      if (!message) break;
      if (message.properties.messageId === pending.messageId) {
        recoveredMessageId = message.properties.messageId;
      }
      brokerChannel.ack(message);
    }
    expect(recoveredMessageId).toBe(pending.messageId);
    expect([a.id, b.id]).toHaveLength(2);
  }, 30_000);

  it('simula caída tras confirmación antes de UPDATE y reintenta con el mismo message_id', async () => {
    await database.query('DELETE FROM inventory.outbox');
    const pending = await publishRecord('inventory.integration.crash');
    const crashingRepo = Object.create(outboxRepo) as DrizzleOutboxRepository;
    crashingRepo.markAsPublished = async (id, client) => {
      if (id === pending.id) {
        await client!.query(
          'INSERT INTO inventory.table_does_not_exist(id) VALUES ($1)',
          [randomUUID()],
        );
        return;
      }
      await outboxRepo.markAsPublished(id, client);
    };
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
    let firstDelivery = false;
    for (;;) {
      const msg = await brokerChannel.get(queue);
      if (!msg) break;
      if (msg.properties.messageId === pending.messageId) firstDelivery = true;
      brokerChannel.ack(msg);
    }
    expect(firstDelivery).toBe(true);
    await database.query(
      `UPDATE inventory.outbox SET created_at=now()-interval '1 day' WHERE id=$1`,
      [pending.id],
    );
    const healthy = await new OutboxPublisherService(
      database,
      outboxRepo,
    ).dispatchPending(1);
    expect(healthy.dispatched).toBe(1);
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
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(`Timeout esperando ${container}: ${String(lastError)}`);
}
