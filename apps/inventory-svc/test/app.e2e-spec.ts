import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { randomUUID } from 'node:crypto';
import { InventorySvcModule } from '../src/inventory-svc.module.js';
import { DatabaseService } from '../src/database/database.service.js';
import { ProblemDetailsFilter } from '../src/errors/problem-details.filter.js';
import { InMemoryDatabaseMock } from './in-memory-database.mock.js';
import {
  createCryptographicJwt,
  TEST_PUBLIC_KEY,
} from './crypto-test-token.helper.js';
import { InventoryAuthGuard } from '../src/auth/inventory-auth.guard.js';

describe('InventorySvc E2E — Corte funcional G5 y Seguridad', () => {
  let app: INestApplication<App>;
  let mockDb: InMemoryDatabaseMock;
  const locLurin = '9129b578-631e-1735-8427-b683fb524380';
  const sku = 'NIK-REV7-NEG-41';

  const validToken = createCryptographicJwt({
    clientId: 'modulo-ventas',
    scope:
      'inventario:reservar inventario:consumir inventario:liberar inventario:operaciones:leer inventario:disponibilidad:leer',
  });

  beforeAll(() => {
    InventoryAuthGuard.setTrustedPublicKey(TEST_PUBLIC_KEY);
  });

  afterAll(() => {
    InventoryAuthGuard.setTrustedPublicKey(null);
  });

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

  it('/health (GET) es público', () => {
    return request(app.getHttpServer()).get('/health').expect(200).expect({
      status: 'ok',
      service: 'inventory-svc',
    });
  });

  describe('Seguridad HTTP y Control de Acceso (Frontera P0)', () => {
    it('debe rechazar con 401 TOKEN_INVALIDO si falta el encabezado Authorization', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/inventario/disponibilidad?skus=${sku}`)
        .expect(401);

      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body.code).toBe('TOKEN_INVALIDO');
      expect(res.body.status).toBe(401);
    });

    it('debe rechazar con 401 TOKEN_INVALIDO si la audiencia no es api-productos', async () => {
      const badAudToken = createCryptographicJwt({
        aud: 'api-otra',
        clientId: 'modulo-ventas',
      });

      const res = await request(app.getHttpServer())
        .get(`/api/v1/inventario/disponibilidad?skus=${sku}`)
        .set('Authorization', `Bearer ${badAudToken}`)
        .expect(401);

      expect(res.body.code).toBe('TOKEN_INVALIDO');
      expect(res.body.detail).toContain('api-productos');
    });

    it('debe rechazar con 401 TOKEN_INVALIDO si el token está expirado', async () => {
      const expiredToken = createCryptographicJwt({
        exp: Math.floor(Date.now() / 1000) - 100,
        clientId: 'modulo-ventas',
      });

      const res = await request(app.getHttpServer())
        .get(`/api/v1/inventario/disponibilidad?skus=${sku}`)
        .set('Authorization', `Bearer ${expiredToken}`)
        .expect(401);

      expect(res.body.code).toBe('TOKEN_INVALIDO');
      expect(res.body.detail).toContain('expirado');
    });

    it('debe rechazar con 403 SCOPE_INSUFICIENTE si el token carece del scope necesario', async () => {
      const noReserveToken = createCryptographicJwt({
        clientId: 'modulo-ventas',
        scope: 'inventario:disponibilidad:leer', // Sin inventario:reservar
      });

      const res = await request(app.getHttpServer())
        .post('/api/v1/inventario/reservas')
        .set('Authorization', `Bearer ${noReserveToken}`)
        .set('Idempotency-Key', randomUUID())
        .send({
          order_id: 'PED-NO-SCOPE',
          operation_id: randomUUID(),
          channel_id: 'VENTAS',
          lines: [{ sku, quantity: 1, location_id: locLurin }],
        })
        .expect(403);

      expect(res.body.code).toBe('SCOPE_INSUFICIENTE');
      expect(res.body.status).toBe(403);
    });

    it('debe rechazar con 403 SCOPE_INSUFICIENTE si el client_id no está autorizado para reservas', async () => {
      const unauthorizedClientToken = createCryptographicJwt({
        clientId: 'modulo-desconocido',
        scope: 'inventario:reservar',
      });

      const res = await request(app.getHttpServer())
        .post('/api/v1/inventario/reservas')
        .set('Authorization', `Bearer ${unauthorizedClientToken}`)
        .set('Idempotency-Key', randomUUID())
        .send({
          order_id: 'PED-UNAUTHORIZED-CLIENT',
          operation_id: randomUUID(),
          channel_id: 'VENTAS',
          lines: [{ sku, quantity: 1, location_id: locLurin }],
        })
        .expect(403);

      expect(res.body.code).toBe('SCOPE_INSUFICIENTE');
    });
  });

  describe('Corte Funcional Autenticado', () => {
    it('/api/v1/inventario/disponibilidad (GET)', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/inventario/disponibilidad?skus=${sku}`)
        .set('Authorization', `Bearer ${validToken}`)
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
        .set('Authorization', `Bearer ${validToken}`)
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
        .set('Authorization', `Bearer ${validToken}`)
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
        .set('Authorization', `Bearer ${validToken}`)
        .set('Idempotency-Key', opIdConfirmar)
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
        .set('Authorization', `Bearer ${validToken}`)
        .expect(200);

      expect(getOpConfirm.body.status).toBe('COMPLETED');
      expect(getOpConfirm.body.operation_type).toBe('CONFIRMAR_CONSUMO');
    });

    it('Ciclo de liberación: solicitar reserva -> liberar por pago no completado', async () => {
      const opIdReserva = randomUUID();
      const orderId = 'PED-E2E-RELEASE';

      await request(app.getHttpServer())
        .post('/api/v1/inventario/reservas')
        .set('Authorization', `Bearer ${validToken}`)
        .set('Idempotency-Key', opIdReserva)
        .send({
          order_id: orderId,
          operation_id: opIdReserva,
          channel_id: 'MARKETPLACE',
          lines: [{ sku, quantity: 1, location_id: locLurin }],
        })
        .expect(202);

      const getOp = await request(app.getHttpServer())
        .get(`/api/v1/inventario/operaciones/${opIdReserva}`)
        .set('Authorization', `Bearer ${validToken}`)
        .expect(200);

      const reservaId = getOp.body.reservation_id;

      const opIdLiberar = randomUUID();
      const postLiberar = await request(app.getHttpServer())
        .post(`/api/v1/inventario/reservas/${reservaId}/liberar`)
        .set('Authorization', `Bearer ${validToken}`)
        .set('Idempotency-Key', opIdLiberar)
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
        .set('Authorization', `Bearer ${validToken}`)
        .set('Idempotency-Key', randomUUID())
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
        .set('Authorization', `Bearer ${validToken}`)
        .set('Idempotency-Key', opId)
        .send({
          order_id: orderId,
          operation_id: opId,
          channel_id: 'MARKETPLACE',
          lines: [{ sku, quantity: 1, location_id: locLurin }],
        })
        .expect(202);

      const res = await request(app.getHttpServer())
        .post('/api/v1/inventario/reservas')
        .set('Authorization', `Bearer ${validToken}`)
        .set('Idempotency-Key', opId)
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
});
