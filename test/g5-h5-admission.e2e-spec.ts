import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { ApiGatewayModule } from '../apps/api-gateway/src/api-gateway.module.js';
import { GatewayIdentity } from '../apps/api-gateway/src/routing/gateway-identity.js';
import {
  GATEWAY_SETTINGS,
  type GatewaySettings,
} from '../apps/api-gateway/src/routing/gateway-settings.js';
import { createSignedIdentity } from '../apps/api-gateway/test/support/signed-identity.js';
import { PromotionsSvcModule } from '../apps/promotions-svc/src/promotions-svc.module.js';
import { CouponH5Operations } from '../apps/promotions-svc/src/coupons/coupon-h5-operations.js';
import { CouponH5Runtime } from '../apps/promotions-svc/src/coupons/coupon-h5-runtime.js';
import { mountCouponH5JsonParser } from '../apps/promotions-svc/src/http/coupon-h5-controller.js';
import { PROMOTIONS_JWKS } from '../apps/promotions-svc/src/http/promotions-identity.js';
import {
  PromotionsConfigService,
  validatePromotionsConfiguration,
} from '../apps/promotions-svc/src/infrastructure/config/promotions-config.js';
import { createEnvironmentFixture } from '../apps/promotions-svc/test/support/environment.js';

describe('Gateway to Promotions H5 without commercial evidence', () => {
  let gateway: INestApplication;
  let promotions: INestApplication;
  const fixture = createEnvironmentFixture();
  const admit = vi.fn();
  const settings = {
    securityMode: 'G7_AUTHENTICATED',
    g5H5Enabled: true,
    upstreams: { 'promotions-svc': '' },
    demoNoAuthEnabled: false,
    publicOperations: [],
    timeoutMs: 3000,
    maxBytes: 1024 * 1024,
  } satisfies GatewaySettings;
  const signed = createSignedIdentity(settings);

  beforeAll(async () => {
    const issuer = 'https://isolated.test/issuer';
    const module = await Test.createTestingModule({
      imports: [PromotionsSvcModule],
    })
      .overrideProvider(PromotionsConfigService)
      .useValue(
        new PromotionsConfigService(
          validatePromotionsConfiguration({
            ...fixture.environment,
            RABBITMQ_URL: undefined,
            AUTH_ISSUER: issuer,
            AUTH_JWKS_URL: `${issuer}/.well-known/jwks.json`,
            G6_SECURITY_MODE: 'G7_AUTHENTICATED',
            GATEWAY_INVENTORY_SVC_URL: 'https://inventory.isolated.test',
            MESSAGING_PROVIDER: 'AZURE_SERVICE_BUS',
            SERVICE_BUS_NAMESPACE_FQDN:
              'g6-coupon-isolated.servicebus.windows.net',
            PROMOTIONS_H5_COUPON_COMMANDS_ENABLED: 'true',
            PROMOTIONS_SERVICE_TOKEN_URL:
              'https://isolated.test/api/v1/auth/token',
            PROMOTIONS_SERVICE_CLIENT_SECRET: 'synthetic-products-secret',
            PROMOTIONS_H5_SERVICE_CLIENT_SECRET: 'synthetic-promotions-secret',
          }),
        ),
      )
      .overrideProvider(PROMOTIONS_JWKS)
      .useValue(async () => [signed.key])
      .overrideProvider(CouponH5Operations)
      .useValue({ admit })
      .compile();
    promotions = module.createNestApplication();
    mountCouponH5JsonParser(promotions);
    await promotions.listen(0, '127.0.0.1');
    settings.upstreams['promotions-svc'] = await promotions.getUrl();
    const gatewayModule = await Test.createTestingModule({
      imports: [ApiGatewayModule],
    })
      .overrideProvider(GATEWAY_SETTINGS)
      .useValue(settings)
      .overrideProvider(GatewayIdentity)
      .useValue(signed.identity)
      .compile();
    gateway = gatewayModule.createNestApplication({ bodyParser: false });
    await gateway.init();
  });

  afterAll(async () => {
    await Promise.all([gateway?.close(), promotions?.close()]);
    fixture.cleanup();
  });

  it('never admits through Gateway even with H5 enabled and a signed client holding the route scopes', async () => {
    const runtime = promotions.get(CouponH5Runtime);
    expect(runtime.enabled).toBe(true);
    expect(() => runtime.assertAvailable()).toThrow(
      'COUPON_H5_RUNTIME_UNAVAILABLE',
    );
    const order_id = 'PED-H5-BOUNDARY';
    const operation_id = randomUUID();
    const consume = () =>
      request(gateway.getHttpServer())
        .post('/api/v1/cupones/consumos')
        .set(
          'Authorization',
          'Bearer ' +
            signed.token({ sub: 'modulo-ventas', scope: 'cupones:consumir' }),
        )
        .set('Idempotency-Key', operation_id)
        .send({
          operation_id,
          order_id,
          coupon_code: 'H5',
          channel_id: 'MARKETPLACE',
          effective_at: '2026-11-21T16:00:00Z',
          reservation_id: randomUUID(),
          commercial_snapshot_ref: order_id,
        });
    settings.g5H5Enabled = false;
    await consume().expect(404);
    settings.g5H5Enabled = true;
    await consume()
      .expect(503)
      .expect(({ body }) => expect(body.code).toBe('SERVICIO_NO_DISPONIBLE'));
    await request(gateway.getHttpServer())
      .post('/api/v1/cupones/restauraciones')
      .set(
        'Authorization',
        'Bearer ' +
          signed.token({ sub: 'modulo-ventas', scope: 'cupones:restaurar' }),
      )
      .set('Idempotency-Key', operation_id)
      .send({
        operation_id,
        order_id,
        consumption_operation_id: randomUUID(),
        cancellation_reason: 'ANULACION',
        cancelled_at: '2026-11-21T16:10:00Z',
      })
      .expect(503)
      .expect(({ body }) => expect(body.code).toBe('SERVICIO_NO_DISPONIBLE'));
    expect(admit).not.toHaveBeenCalled();
  });
});
