import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { InventoryCouponEvidenceController } from '../src/inventory-coupon-evidence.controller.js';
import { InventoryAuthGuard } from '../src/auth/inventory-auth.guard.js';
import { ReservationsService } from '../src/reservations/reservations.service.js';
import {
  createCryptographicJwt,
  TEST_ISSUER,
  TEST_PUBLIC_KEY,
} from './crypto-test-token.helper.js';

describe('Private H5 Inventory evidence', () => {
  let app: INestApplication;
  const reservationId = randomUUID();
  const path =
    '/api/v1/interno/inventario/reservas/' + reservationId + '/evidencia-cupon';
  const orderId = 'PED H5';
  const correlationId = randomUUID();
  const claim = (clientId: string, scope = 'inventario:reservas:estado:leer') =>
    'Bearer ' + createCryptographicJwt({ clientId, scope });
  const snapshot = {
    reservation_id: reservationId,
    order_id: orderId,
    vigencia_efectiva: 'VIGENTE',
  };
  const read = vi.fn().mockResolvedValue(snapshot);

  beforeAll(async () => {
    vi.stubEnv('G7_JWT_ISSUER', TEST_ISSUER);
    vi.stubEnv('G6_SECURITY_MODE', 'G7_AUTHENTICATED');
    InventoryAuthGuard.setTrustedPublicKey(TEST_PUBLIC_KEY);
    const module = await Test.createTestingModule({
      controllers: [InventoryCouponEvidenceController],
      providers: [
        InventoryAuthGuard,
        {
          provide: ReservationsService,
          useValue: { consultarEstadoReserva: read },
        },
      ],
    }).compile();
    app = module.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    InventoryAuthGuard.setTrustedPublicKey(null);
    vi.unstubAllEnvs();
  });

  it('allows only the Promotions technical subject and passes the opaque order through', async () => {
    const get = () =>
      request(app.getHttpServer())
        .get(path)
        .query({ order_id: orderId })
        .set('X-Correlation-Id', correlationId);
    await get().expect(401);
    await get().set('Authorization', claim('modulo-ventas')).expect(403);
    await get().set('Authorization', claim('modulo-productos')).expect(403);
    await get()
      .set(
        'Authorization',
        claim('promotions-svc', 'inventario:operaciones:leer'),
      )
      .expect(403);
    expect(read).not.toHaveBeenCalled();
    await get()
      .set('Authorization', claim('promotions-svc'))
      .expect(200, snapshot);
    expect(read).toHaveBeenCalledExactlyOnceWith(
      reservationId,
      orderId,
      correlationId,
    );
  });
});
