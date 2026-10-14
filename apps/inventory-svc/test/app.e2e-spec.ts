import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { randomUUID } from 'node:crypto';
import { InventorySvcModule } from '../src/inventory-svc.module.js';
import { DatabaseService } from '../src/database/database.service.js';
import { ProblemDetailsFilter } from '../src/errors/problem-details.filter.js';
import { InMemoryDatabaseMock } from './in-memory-database.mock.js';

describe('InventorySvc E2E — Corte funcional G5', () => {
  let app: INestApplication<App>;
  let mockDb: InMemoryDatabaseMock;
  const locLurin = '9129b578-631e-1735-8427-b683fb524380';
  const sku = 'NIK-REV7-NEG-41';

  beforeEach(async () => {
    mockDb = new InMemoryDatabaseMock();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [InventorySvcModule],
    }).compile();

    const dbService = moduleFixture.get<DatabaseService>(DatabaseService);
    dbService.setCustomService(mockDb);

    app = moduleFixture.createNestApplication();
    app.useGlobalFilters(new ProblemDetailsFilter());
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('/health (GET)', () => {
    return request(app.getHttpServer()).get('/health').expect(200).expect({
      status: 'ok',
      service: 'inventory-svc',
    });
  });

  it('/api/v1/inventario/disponibilidad (GET)', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/inventario/disponibilidad?skus=${sku}`)
      .expect(200);

    expect(res.body.items).toBeDefined();
    expect(res.body.items.length).toBeGreaterThan(0);
    expect(res.body.items[0].sku).toBe(sku);
  });

  it('Ciclo completo: solicitar reserva -> consultar operacion -> confirmar consumo', async () => {
    const opIdReserva = randomUUID();
    const orderId = 'PED-E2E-001';

    // 1. Solicitar reserva
    const postReserva = await request(app.getHttpServer())
      .post('/api/v1/inventario/reservas')
      .set('Idempotency-Key', opIdReserva)
      .set('X-Correlation-Id', randomUUID())
      .send({
        order_id: orderId,
        operation_id: opIdReserva,
        channel_id: 'MARKETPLACE',
        lines: [{ sku, quantity: 2, location_id: locLurin }],
      })
      .expect(202);

    expect(postReserva.body.status).toBe('ACCEPTED');
    expect(postReserva.body.operation_id).toBe(opIdReserva);
    expect(postReserva.body.operation_type).toBe('RESERVAR');

    // 2. Consultar operación durable
    const getOp = await request(app.getHttpServer())
      .get(`/api/v1/inventario/operaciones/${opIdReserva}`)
      .expect(200);

    expect(getOp.body.operation_id).toBe(opIdReserva);
    expect(getOp.body.order_id).toBe(orderId);
    expect(getOp.body.status).toBe('COMPLETED');
    expect(getOp.body.reservation_id).toBeDefined();

    const reservaId = getOp.body.reservation_id;

    // 3. Confirmar reserva
    const opIdConfirmar = randomUUID();
    const postConfirmar = await request(app.getHttpServer())
      .post(`/api/v1/inventario/reservas/${reservaId}/confirmar`)
      .send({
        order_id: orderId,
        operation_id: opIdConfirmar,
      })
      .expect(202);

    expect(postConfirmar.body.status).toBe('ACCEPTED');
    expect(postConfirmar.body.operation_type).toBe('CONFIRMAR_CONSUMO');

    // 4. Consultar operación de confirmación
    const getOpConfirm = await request(app.getHttpServer())
      .get(`/api/v1/inventario/operaciones/${opIdConfirmar}`)
      .expect(200);

    expect(getOpConfirm.body.status).toBe('COMPLETED');
    expect(getOpConfirm.body.operation_type).toBe('CONFIRMAR_CONSUMO');
  });

  it('Ciclo de liberación: solicitar reserva -> liberar por pago no completado', async () => {
    const opIdReserva = randomUUID();
    const orderId = 'PED-E2E-RELEASE';

    await request(app.getHttpServer())
      .post('/api/v1/inventario/reservas')
      .send({
        order_id: orderId,
        operation_id: opIdReserva,
        channel_id: 'MARKETPLACE',
        lines: [{ sku, quantity: 1, location_id: locLurin }],
      })
      .expect(202);

    const getOp = await request(app.getHttpServer())
      .get(`/api/v1/inventario/operaciones/${opIdReserva}`)
      .expect(200);

    const reservaId = getOp.body.reservation_id;

    const opIdLiberar = randomUUID();
    const postLiberar = await request(app.getHttpServer())
      .post(`/api/v1/inventario/reservas/${reservaId}/liberar`)
      .send({
        order_id: orderId,
        operation_id: opIdLiberar,
        reason: 'PAGO_NO_COMPLETADO',
      })
      .expect(202);

    expect(postLiberar.body.status).toBe('ACCEPTED');
    expect(postLiberar.body.operation_type).toBe('LIBERAR');
  });

  it('Error 422 CANTIDAD_INVALIDA formateado con Problem Details RFC 7807', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/inventario/reservas')
      .send({
        order_id: 'PED-INVALID',
        operation_id: randomUUID(),
        channel_id: 'MARKETPLACE',
        lines: [{ sku, quantity: 0, location_id: locLurin }],
      })
      .expect(422);

    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body.code).toBe('CANTIDAD_INVALIDA');
    expect(res.body.status).toBe(422);
    expect(res.body.type).toBe('/errores/cantidad-invalida');
  });

  it('Error 409 IDEMPOTENCY_CONFLICT ante reutilización de operation_id con payload distinto', async () => {
    const opId = randomUUID();
    const orderId = 'PED-E2E-CONFLICT';

    await request(app.getHttpServer())
      .post('/api/v1/inventario/reservas')
      .send({
        order_id: orderId,
        operation_id: opId,
        channel_id: 'MARKETPLACE',
        lines: [{ sku, quantity: 1, location_id: locLurin }],
      })
      .expect(202);

    const res = await request(app.getHttpServer())
      .post('/api/v1/inventario/reservas')
      .send({
        order_id: orderId,
        operation_id: opId,
        channel_id: 'MARKETPLACE',
        lines: [{ sku, quantity: 5, location_id: locLurin }],
      })
      .expect(409);

    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(res.body.status).toBe(409);
  });
});
