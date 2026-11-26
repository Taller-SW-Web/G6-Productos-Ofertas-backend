import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import request from 'supertest';
import { InventorySvcModule } from '../../src/inventory-svc.module.js';
import { DatabaseService } from '../../src/database/database.service.js';
import { ProblemDetailsFilter } from '../../src/errors/problem-details.filter.js';
import { InventoryAuthGuard } from '../../src/auth/inventory-auth.guard.js';
import { InventoryCommandService } from '../../src/inbox/inventory-command.service.js';
import { OutboxService } from '../../src/outbox/outbox.service.js';
import { InMemoryDatabaseMock } from '../in-memory-database.mock.js';
import {
  createCryptographicJwt,
  TEST_ISSUER,
  TEST_PUBLIC_KEY,
} from '../crypto-test-token.helper.js';
import { generateInventoryFixtureData } from '../../../../scripts/h5/fixtures/inventory/generate-inventory-fixture.mjs';

describe('TAC-A02 / INT-02 — Matriz completa de reservas, operaciones durables, concurrencia y recuperación (INV-INT01 a INV-INT12)', () => {
  let app: INestApplication;
  let db: InMemoryDatabaseMock;

  const fixture = generateInventoryFixtureData({
    seed: 'int02-suite-20261126',
    profile: 'small',
  });
  const locA = fixture.locations[0].id;
  const locB = fixture.locations[1].id;
  const skuMain = fixture.skus[9].sku; // STANDARD_AVAILABLE en locA (on_hand >= 20)

  const ventasToken = (
    overrides: Parameters<typeof createCryptographicJwt>[0] = {},
  ) =>
    createCryptographicJwt({
      clientId: 'modulo-ventas',
      scope:
        'inventario:reservar inventario:consumir inventario:liberar inventario:operaciones:leer inventario:reservas:estado:leer inventario:disponibilidad:leer',
      ...overrides,
    });

  const channelToken = (
    clientId: 'modulo-marketplace' | 'modulo-retail',
    overrides: Parameters<typeof createCryptographicJwt>[0] = {},
  ) =>
    createCryptographicJwt({
      clientId,
      scope: 'inventario:disponibilidad:leer',
      ...overrides,
    });

  beforeAll(() => {
    vi.stubEnv('G7_JWT_ISSUER', TEST_ISSUER);
    InventoryAuthGuard.setTrustedPublicKey(TEST_PUBLIC_KEY);
  });

  afterAll(() => {
    InventoryAuthGuard.setTrustedPublicKey(null);
    vi.unstubAllEnvs();
  });

  beforeEach(async () => {
    db = new InMemoryDatabaseMock();
    db.locations = fixture.locations.map((l) => ({ ...l }));
    db.stockBalance = fixture.balances.map((b) => ({
      ...b,
      stock_version: 1,
    }));
    db.commercialRoutes = fixture.commercialRoutes.map((r) => ({ ...r }));

    const module = await Test.createTestingModule({
      imports: [InventorySvcModule],
    }).compile();
    module.get(DatabaseService).setCustomService(db);
    app = module.createNestApplication();
    app.useGlobalFilters(new ProblemDetailsFilter());
    await app.init();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  it('INV-INT01: reservar unidades dentro del disponible crea registro durable, operación única y saldo coherente', async () => {
    const http = request(app.getHttpServer());
    const balanceBefore = db.stockBalance.find(
      (b) => b.sku_id === skuMain && b.location_id === locA,
    )!;
    const initialOnHand = balanceBefore.on_hand;
    const opId = randomUUID();
    const idemKey = `int01-${opId}`;

    const res = await http
      .post('/api/v1/inventario/reservas')
      .set('Authorization', `Bearer ${ventasToken()}`)
      .set('Idempotency-Key', idemKey)
      .send({
        order_id: 'PED-INT01-001',
        operation_id: opId,
        channel_id: 'MARKETPLACE',
        lines: [{ sku: skuMain, quantity: 3, location_id: locA }],
      })
      .expect(202);

    expect(res.body).toMatchObject({
      operation_id: opId,
      order_id: 'PED-INT01-001',
      operation_type: 'RESERVAR',
      status: 'ACCEPTED',
    });

    const balanceAfter = db.stockBalance.find(
      (b) => b.sku_id === skuMain && b.location_id === locA,
    )!;
    expect(balanceAfter.on_hand).toBe(initialOnHand);
    expect(balanceAfter.reserved).toBe(3);
    expect(balanceAfter.available).toBe(initialOnHand - 3);
    expect(balanceAfter.stock_version).toBe(2);

    expect(db.reservations).toHaveLength(1);
    expect(db.reservations[0].order_id).toBe('PED-INT01-001');
    expect(db.reservations[0].status).toBe('ACTIVA');
    expect(db.operations.filter((o) => o.operation_id === opId)).toHaveLength(
      1,
    );
    expect(db.outbox.length).toBeGreaterThanOrEqual(1);
  });

  it('INV-INT02: reservar más del disponible rechaza durablemente (REJECTED STOCK_INSUFICIENTE) sin dejar negativo ni inventar stock', async () => {
    const http = request(app.getHttpServer());
    const balanceBefore = db.stockBalance.find(
      (b) => b.sku_id === skuMain && b.location_id === locA,
    )!;
    const tooMany = balanceBefore.available + 50;
    const opId = randomUUID();

    await http
      .post('/api/v1/inventario/reservas')
      .set('Authorization', `Bearer ${ventasToken()}`)
      .set('Idempotency-Key', `int02-${opId}`)
      .send({
        order_id: 'PED-INT02-001',
        operation_id: opId,
        channel_id: 'MARKETPLACE',
        lines: [{ sku: skuMain, quantity: tooMany, location_id: locA }],
      })
      .expect(202);

    const opRes = await http
      .get(`/api/v1/inventario/operaciones/${opId}`)
      .set('Authorization', `Bearer ${ventasToken()}`)
      .expect(200);

    expect(opRes.body.status).toBe('REJECTED');
    expect(opRes.body.result_code).toBe('STOCK_INSUFICIENTE');
    const balanceAfter = db.stockBalance.find(
      (b) => b.sku_id === skuMain && b.location_id === locA,
    )!;
    expect(balanceAfter.reserved).toBe(0);
    expect(balanceAfter.available).toBe(balanceBefore.available);
    expect(balanceAfter.available).toBeGreaterThanOrEqual(0);
    expect(db.reservations).toHaveLength(0);
  });

  it('INV-INT03: replay con mismo operation_id, Idempotency-Key e intención produce una sola reserva y un solo ajuste durable', async () => {
    const http = request(app.getHttpServer());
    const opId = randomUUID();
    const idemKey = `int03-${opId}`;
    const payload = {
      order_id: 'PED-INT03-001',
      operation_id: opId,
      channel_id: 'MARKETPLACE',
      lines: [{ sku: skuMain, quantity: 2, location_id: locA }],
    };

    const first = await http
      .post('/api/v1/inventario/reservas')
      .set('Authorization', `Bearer ${ventasToken()}`)
      .set('Idempotency-Key', idemKey)
      .send(payload)
      .expect(202);

    const replay = await http
      .post('/api/v1/inventario/reservas')
      .set('Authorization', `Bearer ${ventasToken()}`)
      .set('Idempotency-Key', idemKey)
      .send(payload)
      .expect(202);

    expect(replay.body.operation_id).toBe(first.body.operation_id);
    expect(db.reservations).toHaveLength(1);
    const balance = db.stockBalance.find(
      (b) => b.sku_id === skuMain && b.location_id === locA,
    )!;
    expect(balance.reserved).toBe(2);
    expect(db.kardex.filter((k) => k.operation_id === opId)).toHaveLength(1);
  });

  it('INV-INT04: misma identidad con payload incompatible devuelve 409 IDEMPOTENCY_CONFLICT sin segunda mutación', async () => {
    const http = request(app.getHttpServer());
    const opId = randomUUID();
    const idemKey = `int04-${opId}`;

    await http
      .post('/api/v1/inventario/reservas')
      .set('Authorization', `Bearer ${ventasToken()}`)
      .set('Idempotency-Key', idemKey)
      .send({
        order_id: 'PED-INT04-001',
        operation_id: opId,
        channel_id: 'MARKETPLACE',
        lines: [{ sku: skuMain, quantity: 2, location_id: locA }],
      })
      .expect(202);

    const conflict = await http
      .post('/api/v1/inventario/reservas')
      .set('Authorization', `Bearer ${ventasToken()}`)
      .set('Idempotency-Key', idemKey)
      .send({
        order_id: 'PED-INT04-001',
        operation_id: opId,
        channel_id: 'MARKETPLACE',
        lines: [{ sku: skuMain, quantity: 5, location_id: locA }],
      })
      .expect(409);

    expect(conflict.body.code).toBe('IDEMPOTENCY_CONFLICT');
    const balance = db.stockBalance.find(
      (b) => b.sku_id === skuMain && b.location_id === locA,
    )!;
    expect(balance.reserved).toBe(2);
    expect(db.reservations).toHaveLength(1);
  });

  it('INV-INT05: dos reservas concurrentes sobre últimas unidades evitan sobreventa', async () => {
    const http = request(app.getHttpServer());
    const balance = db.stockBalance.find(
      (b) => b.sku_id === skuMain && b.location_id === locA,
    )!;
    balance.on_hand = 5;
    balance.reserved = 0;
    balance.blocked = 0;
    balance.available = 5;

    const op1 = randomUUID();
    const op2 = randomUUID();

    const [res1, res2] = await Promise.all([
      http
        .post('/api/v1/inventario/reservas')
        .set('Authorization', `Bearer ${ventasToken()}`)
        .set('Idempotency-Key', `int05-a-${op1}`)
        .send({
          order_id: 'PED-INT05-A',
          operation_id: op1,
          channel_id: 'MARKETPLACE',
          lines: [{ sku: skuMain, quantity: 4, location_id: locA }],
        }),
      http
        .post('/api/v1/inventario/reservas')
        .set('Authorization', `Bearer ${ventasToken()}`)
        .set('Idempotency-Key', `int05-b-${op2}`)
        .send({
          order_id: 'PED-INT05-B',
          operation_id: op2,
          channel_id: 'MARKETPLACE',
          lines: [{ sku: skuMain, quantity: 4, location_id: locA }],
        }),
    ]);

    expect(res1.status).toBe(202);
    expect(res2.status).toBe(202);

    const [opStatus1, opStatus2] = await Promise.all([
      http
        .get(`/api/v1/inventario/operaciones/${op1}`)
        .set('Authorization', `Bearer ${ventasToken()}`)
        .expect(200),
      http
        .get(`/api/v1/inventario/operaciones/${op2}`)
        .set('Authorization', `Bearer ${ventasToken()}`)
        .expect(200),
    ]);

    expect([opStatus1.body.status, opStatus2.body.status].sort()).toEqual([
      'COMPLETED',
      'REJECTED',
    ]);
    const rejectedOp =
      opStatus1.body.status === 'REJECTED' ? opStatus1.body : opStatus2.body;
    expect(rejectedOp.result_code).toBe('STOCK_INSUFICIENTE');

    expect(balance.reserved).toBe(4);
    expect(balance.available).toBe(1);
    expect(balance.available).toBeGreaterThanOrEqual(0);
    expect(db.reservations).toHaveLength(1);
  });

  it('INV-INT06: confirmar dos veces es idempotente sin doble descuento y liberar tras confirmar se rechaza', async () => {
    const http = request(app.getHttpServer());
    const balance = db.stockBalance.find(
      (b) => b.sku_id === skuMain && b.location_id === locA,
    )!;
    const initialOnHand = balance.on_hand;
    const reserveOpId = randomUUID();

    await http
      .post('/api/v1/inventario/reservas')
      .set('Authorization', `Bearer ${ventasToken()}`)
      .set('Idempotency-Key', `int06-res-${reserveOpId}`)
      .send({
        order_id: 'PED-INT06-001',
        operation_id: reserveOpId,
        channel_id: 'MARKETPLACE',
        lines: [{ sku: skuMain, quantity: 3, location_id: locA }],
      })
      .expect(202);

    const reservationId = db.reservations[0].reservation_id;
    const confirmOpId = randomUUID();
    const confirmKey = `int06-conf-${confirmOpId}`;

    await http
      .post(`/api/v1/inventario/reservas/${reservationId}/confirmar`)
      .set('Authorization', `Bearer ${ventasToken()}`)
      .set('Idempotency-Key', confirmKey)
      .send({ order_id: 'PED-INT06-001', operation_id: confirmOpId })
      .expect(202);

    // Segundo confirmar con misma clave -> replay idempotente, sin doble descuento
    await http
      .post(`/api/v1/inventario/reservas/${reservationId}/confirmar`)
      .set('Authorization', `Bearer ${ventasToken()}`)
      .set('Idempotency-Key', confirmKey)
      .send({ order_id: 'PED-INT06-001', operation_id: confirmOpId })
      .expect(202);

    expect(balance.on_hand).toBe(initialOnHand - 3);
    expect(balance.reserved).toBe(0);
    expect(db.reservations[0].status).toBe('CONSUMIDA');

    // Orden incorrecto: intentar liberar una reserva ya CONSUMIDA
    const releaseOpId = randomUUID();
    const releaseRes = await http
      .post(`/api/v1/inventario/reservas/${reservationId}/liberar`)
      .set('Authorization', `Bearer ${ventasToken()}`)
      .set('Idempotency-Key', `int06-rel-${releaseOpId}`)
      .send({
        order_id: 'PED-INT06-001',
        operation_id: releaseOpId,
        reason: 'ANULACION',
      });
    expect(releaseRes.status).toBe(409);
    expect(balance.on_hand).toBe(initialOnHand - 3);
  });

  it('INV-INT07: reserva ACTIVA con expires_at <= observed_at reporta VENCIDA, no utilizable y GET no muta stock', async () => {
    const http = request(app.getHttpServer());
    const reservationId = randomUUID();
    db.reservations.push({
      reservation_id: reservationId,
      order_id: 'PED-INT07-EXP',
      operation_id: randomUUID(),
      channel_id: 'MARKETPLACE',
      status: 'ACTIVA',
      expires_at: new Date('2025-01-01T00:00:00.000Z'),
      created_at: new Date('2025-01-01T00:00:00.000Z'),
      consumed_at: null,
      released_at: null,
      expired_at: null,
    });
    const stockSnapshotBefore = JSON.stringify(db.stockBalance);

    const res = await http
      .get(
        `/api/v1/inventario/reservas/${reservationId}/estado?order_id=PED-INT07-EXP`,
      )
      .set('Authorization', `Bearer ${ventasToken()}`)
      .expect(200);

    expect(res.body).toMatchObject({
      reservation_id: reservationId,
      order_id: 'PED-INT07-EXP',
      estado_persistido: 'ACTIVA',
      vigencia_efectiva: 'VENCIDA',
      permite_pago: false,
      permite_consumo_cupon: false,
    });
    expect(Object.keys(res.body).sort()).toEqual([
      'estado_persistido',
      'expires_at',
      'observed_at',
      'order_id',
      'permite_consumo_cupon',
      'permite_pago',
      'reservation_id',
      'vigencia_efectiva',
    ]);
    expect(JSON.stringify(db.stockBalance)).toBe(stockSnapshotBefore);
    expect(db.reservations[0].status).toBe('ACTIVA');
  });

  it('INV-INT08: GET estado de reserva con order_id ajeno devuelve 404 RESERVA_NO_ENCONTRADA uniforme', async () => {
    const http = request(app.getHttpServer());
    const reservationId = randomUUID();
    db.reservations.push({
      reservation_id: reservationId,
      order_id: 'PED-DUENO-REAL',
      operation_id: randomUUID(),
      channel_id: 'MARKETPLACE',
      status: 'ACTIVA',
      expires_at: new Date(Date.now() + 60_000),
      created_at: new Date(),
      consumed_at: null,
      released_at: null,
      expired_at: null,
    });

    const res = await http
      .get(
        `/api/v1/inventario/reservas/${reservationId}/estado?order_id=PED-AJENO`,
      )
      .set('Authorization', `Bearer ${ventasToken()}`)
      .expect(404);

    expect(res.body.code).toBe('RESERVA_NO_ENCONTRADA');
  });

  it('INV-INT09: disponibilidad comercial con 2 ubicaciones/canales respeta fulfillment y no suma arbitrariamente', async () => {
    const http = request(app.getHttpServer());
    // skuDiff tiene 10 en locA (MARKETPLACE ENVIO_DOMICILIO) y 0 en locB (RETAIL RETIRO_TIENDA)
    const skuDiff = 'SYN-FULFILLMENT-SPLIT';
    db.stockBalance.push(
      {
        sku_id: skuDiff,
        location_id: locA,
        on_hand: 10,
        reserved: 0,
        blocked: 0,
        available: 10,
        stock_version: 1,
      },
      {
        sku_id: skuDiff,
        location_id: locB,
        on_hand: 0,
        reserved: 0,
        blocked: 0,
        available: 0,
        stock_version: 1,
      },
    );

    const mktVerify = await http
      .post('/api/v1/inventario/disponibilidad/comercial/verificar')
      .set('Authorization', `Bearer ${channelToken('modulo-marketplace')}`)
      .send({
        channel_id: 'MARKETPLACE',
        fulfillment: { mode: 'ENVIO_DOMICILIO' },
        lines: [{ sku: skuDiff, quantity: 5 }],
      })
      .expect(200);
    expect(mktVerify.body.items[0].result).toBe('SUFICIENTE');

    // En RETAIL (locB = 0) pedir 5 no debe sumar los 10 de MARKETPLACE (locA)
    const retVerify = await http
      .post('/api/v1/inventario/disponibilidad/comercial/verificar')
      .set('Authorization', `Bearer ${channelToken('modulo-retail')}`)
      .send({
        channel_id: 'RETAIL',
        fulfillment: { mode: 'RETIRO_TIENDA' },
        lines: [{ sku: skuDiff, quantity: 5 }],
      })
      .expect(200);
    expect(retVerify.body.items[0].result).toBe('INDETERMINADO');
  });

  it('INV-INT10: fallo de BD tras actualizar stock revierte toda la transacción y retry conserva identidad', async () => {
    const http = request(app.getHttpServer());
    const outbox = app.get(OutboxService);
    const balance = db.stockBalance.find(
      (b) => b.sku_id === skuMain && b.location_id === locA,
    )!;
    const initialReserved = balance.reserved;
    const initialAvailable = balance.available;

    const enqueueSpy = vi
      .spyOn(outbox, 'enqueue')
      .mockRejectedValueOnce(new Error('DB_ABORT_BEFORE_OUTBOX'));

    const opId = randomUUID();
    const idemKey = `int10-${opId}`;
    const payload = {
      order_id: 'PED-INT10-ROLLBACK',
      operation_id: opId,
      channel_id: 'MARKETPLACE',
      lines: [{ sku: skuMain, quantity: 2, location_id: locA }],
    };

    const failed = await http
      .post('/api/v1/inventario/reservas')
      .set('Authorization', `Bearer ${ventasToken()}`)
      .set('Idempotency-Key', idemKey)
      .send(payload);
    expect(failed.status).toBeGreaterThanOrEqual(500);
    expect(enqueueSpy).toHaveBeenCalledTimes(1);

    // Rollback íntegro garantizado (reconsultar db.stockBalance tras restoreState)
    const balanceAfterRollback = db.stockBalance.find(
      (b) => b.sku_id === skuMain && b.location_id === locA,
    )!;
    expect(balanceAfterRollback.reserved).toBe(initialReserved);
    expect(balanceAfterRollback.available).toBe(initialAvailable);
    expect(db.reservations).toHaveLength(0);
    expect(db.operations).toHaveLength(0);
    expect(db.outbox).toHaveLength(0);

    // Retry tras recuperación conserva identidad y completa una sola vez
    enqueueSpy.mockRestore();
    await http
      .post('/api/v1/inventario/reservas')
      .set('Authorization', `Bearer ${ventasToken()}`)
      .set('Idempotency-Key', idemKey)
      .send(payload)
      .expect(202);

    const balanceAfterRetry = db.stockBalance.find(
      (b) => b.sku_id === skuMain && b.location_id === locA,
    )!;
    expect(balanceAfterRetry.reserved).toBe(initialReserved + 2);
    expect(db.reservations).toHaveLength(1);
    expect(db.operations).toHaveLength(1);
  });

  it('INV-INT11: consumer R06/R11 que reinicia tras commit antes de ACK evita segunda mutación vía Inbox y conserva versión', async () => {
    const commandService = app.get(InventoryCommandService);
    const skuNew = 'SYN-R06-INIT-NEW';
    const messageId = randomUUID();
    const operationId = randomUUID();
    const correlationId = randomUUID();

    const asyncApiPayload = {
      message_id: messageId,
      operation_id: operationId,
      correlation_id: correlationId,
      occurred_at: new Date().toISOString(),
      kind: 'command',
      name: 'inventory.sku.initialization.requested',
      producer: 'catalog-svc',
      schema_version: 2,
      data: {
        sku: skuNew,
        product_id: randomUUID(),
        variant_id: null,
        default_location_id: locA,
      },
    };

    const first = await commandService.process(asyncApiPayload);
    expect(first.duplicate).toBe(false);
    expect(first.status).toBe('INITIALIZED');

    const balanceAfterFirst = db.stockBalance.find(
      (b) => b.sku_id === skuNew && b.location_id === locA,
    )!;
    expect(balanceAfterFirst).toBeDefined();
    expect(balanceAfterFirst.stock_version).toBe(0);
    const outboxCountAfterFirst = db.outbox.length;

    // Simula redelivery tras caída antes de ACK con mismo message_id
    const redelivery = await commandService.process(asyncApiPayload);
    expect(redelivery.duplicate).toBe(true);
    expect(balanceAfterFirst.stock_version).toBe(0);
    expect(db.outbox.length).toBe(outboxCountAfterFirst);
    expect(db.inbox).toHaveLength(1);
  });

  it('INV-INT12: rechaza con 401 sin JWT y 403 ante scope o client_id incorrecto sin tocar BD', async () => {
    const http = request(app.getHttpServer());
    const txSpy = vi.spyOn(db, 'transaction');

    // Sin token -> 401
    await http
      .post('/api/v1/inventario/reservas')
      .set('Idempotency-Key', 'int12-no-jwt')
      .send({
        order_id: 'PED-INT12-1',
        operation_id: randomUUID(),
        channel_id: 'MARKETPLACE',
        lines: [{ sku: skuMain, quantity: 1, location_id: locA }],
      })
      .expect(401);

    // Scope insuficiente -> 403
    await http
      .post('/api/v1/inventario/reservas')
      .set(
        'Authorization',
        `Bearer ${ventasToken({ scope: 'inventario:disponibilidad:leer' })}`,
      )
      .set('Idempotency-Key', 'int12-bad-scope')
      .send({
        order_id: 'PED-INT12-2',
        operation_id: randomUUID(),
        channel_id: 'MARKETPLACE',
        lines: [{ sku: skuMain, quantity: 1, location_id: locA }],
      })
      .expect(403);

    // Cliente no autorizado (modulo-promotions no puede reservar ni leer estado de reserva) -> 403
    await http
      .get(`/api/v1/inventario/reservas/${randomUUID()}/estado?order_id=PED-1`)
      .set(
        'Authorization',
        `Bearer ${createCryptographicJwt({
          clientId: 'modulo-promotions',
          scope: 'inventario:reservas:estado:leer',
        })}`,
      )
      .expect(403);

    expect(txSpy).not.toHaveBeenCalled();
  });
});
