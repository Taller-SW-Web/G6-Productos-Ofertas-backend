import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ReservationsService } from './reservations.service.js';
import { IdempotencyService } from '../idempotency/idempotency.service.js';
import { KardexService } from '../kardex/kardex.service.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { DatabaseService } from '../database/database.service.js';
import { InMemoryDatabaseMock } from '../../test/in-memory-database.mock.js';
import { ProblemDetailsException } from '../errors/inventory.errors.js';

import { DrizzleReservationsRepository } from '../repositories/drizzle/drizzle-reservations.repository.js';
import { DrizzleStockBalanceRepository } from '../repositories/drizzle/drizzle-stock-balance.repository.js';
import { DrizzleOperationsRepository } from '../repositories/drizzle/drizzle-operations.repository.js';
import { DrizzleLocationsRepository } from '../repositories/drizzle/drizzle-locations.repository.js';
import { DrizzleCommercialRoutesRepository } from '../repositories/drizzle/drizzle-commercial-routes.repository.js';
import { DrizzleKardexRepository } from '../repositories/drizzle/drizzle-kardex.repository.js';
import { DrizzleOutboxRepository } from '../repositories/drizzle/drizzle-outbox.repository.js';

describe('ReservationsService — Ciclo Completo G5 (Confirmación y Liberación)', () => {
  let reservationsService: ReservationsService;
  let mockDb: InMemoryDatabaseMock;
  let dbService: DatabaseService;

  const locLurin = '9129b578-631e-1735-8427-b683fb524380';
  const sku = 'NIK-REV7-NEG-41'; // on_hand = 18

  beforeEach(() => {
    mockDb = new InMemoryDatabaseMock();
    dbService = new DatabaseService();
    dbService.setCustomService(mockDb);

    const idempotencyService = new IdempotencyService();
    const kardexRepo = new DrizzleKardexRepository(dbService);
    const kardexService = new KardexService(kardexRepo);
    const outboxRepo = new DrizzleOutboxRepository(dbService);
    const outboxService = new OutboxService(outboxRepo);

    const reservationsRepo = new DrizzleReservationsRepository(dbService);
    const stockBalanceRepo = new DrizzleStockBalanceRepository(dbService);
    const operationsRepo = new DrizzleOperationsRepository(dbService);
    const locationsRepo = new DrizzleLocationsRepository(dbService);
    const commercialRoutesRepo = new DrizzleCommercialRoutesRepository(
      dbService,
    );

    reservationsService = new ReservationsService(
      dbService,
      idempotencyService,
      kardexService,
      outboxService,
      reservationsRepo,
      stockBalanceRepo,
      operationsRepo,
      locationsRepo,
      commercialRoutesRepo,
    );
  });

  describe('Confirmación de reserva (POST /api/v1/inventario/reservas/{reservaId}/confirmar)', () => {
    it('debe confirmar consumo definitivo, descontar on_hand y reserved, y generar kardex/outbox', async () => {
      // 1. Crear reserva
      const orderId = 'PED-CONFIRM-01';
      const opReserva = randomUUID();
      await reservationsService.solicitarReserva({
        order_id: orderId,
        operation_id: opReserva,
        channel_id: 'MARKETPLACE',
        lines: [{ sku, quantity: 3, location_id: locLurin }],
      });

      const reservaCreada = mockDb.reservations[0];
      const reservaId = reservaCreada.reservation_id;

      const balBefore = mockDb.stockBalance.find(
        (b) => b.sku_id === sku && b.location_id === locLurin,
      )!;
      expect(balBefore.on_hand).toBe(18);
      expect(balBefore.reserved).toBe(3);

      // 2. Confirmar reserva
      const opConfirmar = randomUUID();
      const resConfirm = await reservationsService.confirmarReserva(reservaId, {
        order_id: orderId,
        operation_id: opConfirmar,
      });

      expect(resConfirm.status).toBe('ACCEPTED');
      expect(resConfirm.operation_type).toBe('CONFIRMAR_CONSUMO');

      // 3. Verificar estado en base de datos
      expect(reservaCreada.status).toBe('CONSUMIDA');
      expect(reservaCreada.consumed_at).toBeDefined();

      const balAfter = mockDb.stockBalance.find(
        (b) => b.sku_id === sku && b.location_id === locLurin,
      )!;
      expect(balAfter.on_hand).toBe(15); // 18 - 3 = 15
      expect(balAfter.reserved).toBe(0); // 3 - 3 = 0
      expect(balAfter.available).toBe(15);

      // 4. Kardex
      const consumoKardex = mockDb.kardex.find(
        (k) => k.operation_type === 'CONSUMO' && k.reservation_id === reservaId,
      );
      expect(consumoKardex).toBeDefined();
      expect(consumoKardex?.quantity).toBe(-3);
      expect(consumoKardex?.on_hand_before).toBe(18);
      expect(consumoKardex?.on_hand_after).toBe(15);

      // 5. Outbox
      const consumedEvent = mockDb.outbox.find(
        (e) => e.event_type === 'inventory.reservation.consumed',
      );
      const completedResult = mockDb.outbox.find(
        (e) => e.event_type === 'inventory.consumption.completed',
      );

      expect(consumedEvent).toBeDefined();
      expect(completedResult).toBeDefined();
      expect(completedResult?.payload?.data?.order_id).toBe(orderId);
      expect(completedResult?.payload?.data?.reservation_id).toBe(reservaId);
    });

    it('debe responder de forma idempotente ante reintentos de confirmación', async () => {
      const orderId = 'PED-CONFIRM-IDEMPOTENT';
      const opReserva = randomUUID();
      await reservationsService.solicitarReserva({
        order_id: orderId,
        operation_id: opReserva,
        channel_id: 'MARKETPLACE',
        lines: [{ sku, quantity: 2, location_id: locLurin }],
      });

      const reservaId = mockDb.reservations[0].reservation_id;
      const opConfirmar = randomUUID();

      // Primera confirmación
      const res1 = await reservationsService.confirmarReserva(reservaId, {
        order_id: orderId,
        operation_id: opConfirmar,
      });
      expect(res1.status).toBe('ACCEPTED');

      const balFirst = mockDb.stockBalance.find(
        (b) => b.sku_id === sku && b.location_id === locLurin,
      )!;
      expect(balFirst.on_hand).toBe(16);

      // Segunda confirmación idéntica
      const res2 = await reservationsService.confirmarReserva(reservaId, {
        order_id: orderId,
        operation_id: opConfirmar,
      });
      expect(res2.status).toBe('ACCEPTED');

      // No hay doble descuento
      const balSecond = mockDb.stockBalance.find(
        (b) => b.sku_id === sku && b.location_id === locLurin,
      )!;
      expect(balSecond.on_hand).toBe(16);
    });

    it('debe lanzar 404 RESERVA_NO_ENCONTRADA si la reserva no existe', async () => {
      const nonExistentId = randomUUID();
      await expect(
        reservationsService.confirmarReserva(nonExistentId, {
          order_id: 'PED-UNKNOWN',
          operation_id: randomUUID(),
        }),
      ).rejects.toThrow(ProblemDetailsException);

      try {
        await reservationsService.confirmarReserva(nonExistentId, {
          order_id: 'PED-UNKNOWN',
          operation_id: randomUUID(),
        });
      } catch (err) {
        const pde = err as ProblemDetailsException;
        expect(pde.problem.status).toBe(404);
        expect(pde.problem.code).toBe('RESERVA_NO_ENCONTRADA');
      }
    });

    it('debe lanzar 409 RESERVA_NO_ACTIVA si se intenta confirmar una reserva ya consumida con otra operación', async () => {
      const orderId = 'PED-DOUBLE-CONFIRM';
      await reservationsService.solicitarReserva({
        order_id: orderId,
        operation_id: randomUUID(),
        channel_id: 'MARKETPLACE',
        lines: [{ sku, quantity: 1, location_id: locLurin }],
      });

      const reservaId = mockDb.reservations[0].reservation_id;

      // Primera confirmación
      await reservationsService.confirmarReserva(reservaId, {
        order_id: orderId,
        operation_id: randomUUID(),
      });

      // Segunda confirmación con operation_id distinto
      try {
        await reservationsService.confirmarReserva(reservaId, {
          order_id: orderId,
          operation_id: randomUUID(),
        });
        expect.unreachable('Debe lanzar excepción');
      } catch (err) {
        const pde = err as ProblemDetailsException;
        expect(pde.problem.status).toBe(409);
        expect(pde.problem.code).toBe('RESERVA_NO_ACTIVA');
      }
    });
  });

  describe('Liberación de reserva (POST /api/v1/inventario/reservas/{reservaId}/liberar)', () => {
    it('debe liberar reserva activa, restaurar stock reservado sin mutar on_hand, y emitir eventos', async () => {
      // 1. Crear reserva
      const orderId = 'PED-RELEASE-01';
      await reservationsService.solicitarReserva({
        order_id: orderId,
        operation_id: randomUUID(),
        channel_id: 'MARKETPLACE',
        lines: [{ sku, quantity: 4, location_id: locLurin }],
      });

      const reservaCreada = mockDb.reservations[0];
      const reservaId = reservaCreada.reservation_id;

      const balBefore = mockDb.stockBalance.find(
        (b) => b.sku_id === sku && b.location_id === locLurin,
      )!;
      expect(balBefore.on_hand).toBe(18);
      expect(balBefore.reserved).toBe(4);

      // 2. Liberar reserva
      const opLiberar = randomUUID();
      const resLiberar = await reservationsService.liberarReserva(reservaId, {
        order_id: orderId,
        operation_id: opLiberar,
        reason: 'PAGO_NO_COMPLETADO',
      });

      expect(resLiberar.status).toBe('ACCEPTED');
      expect(resLiberar.operation_type).toBe('LIBERAR');

      // 3. Verificar estado en base de datos
      expect(reservaCreada.status).toBe('LIBERADA');
      expect(reservaCreada.released_at).toBeDefined();

      const balAfter = mockDb.stockBalance.find(
        (b) => b.sku_id === sku && b.location_id === locLurin,
      )!;
      expect(balAfter.on_hand).toBe(18); // Intacto
      expect(balAfter.reserved).toBe(0); // 4 - 4 = 0
      expect(balAfter.available).toBe(18);

      // 4. Kardex
      const liberacionKardex = mockDb.kardex.find(
        (k) =>
          k.operation_type === 'LIBERACION' && k.reservation_id === reservaId,
      );
      expect(liberacionKardex).toBeDefined();
      expect(liberacionKardex?.quantity).toBe(-4);

      // 5. Outbox
      const releasedEvent = mockDb.outbox.find(
        (e) => e.event_type === 'inventory.reservation.released',
      );
      expect(releasedEvent).toBeDefined();
      expect(releasedEvent?.payload?.data?.reason_code).toBe(
        'PAGO_NO_COMPLETADO',
      );
    });

    it('debe rechazar con 409 RESERVA_NO_ACTIVA si se intenta liberar una reserva ya consumida', async () => {
      const orderId = 'PED-CONSUMED-THEN-RELEASE';
      await reservationsService.solicitarReserva({
        order_id: orderId,
        operation_id: randomUUID(),
        channel_id: 'MARKETPLACE',
        lines: [{ sku, quantity: 2, location_id: locLurin }],
      });

      const reservaId = mockDb.reservations[0].reservation_id;

      await reservationsService.confirmarReserva(reservaId, {
        order_id: orderId,
        operation_id: randomUUID(),
      });

      try {
        await reservationsService.liberarReserva(reservaId, {
          order_id: orderId,
          operation_id: randomUUID(),
          reason: 'ANULACION',
        });
        expect.unreachable('Debe lanzar excepción');
      } catch (err) {
        const pde = err as ProblemDetailsException;
        expect(pde.problem.status).toBe(409);
        expect(pde.problem.code).toBe('RESERVA_NO_ACTIVA');
      }
    });
  });
});
