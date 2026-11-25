import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import request from 'supertest';
import { PromotionsSvcModule } from '../src/promotions-svc.module.js';
import {
  CouponH5Operations,
  prepareCouponH5Admission,
  type CouponH5Admission,
} from '../src/coupons/coupon-h5-operations.js';
import {
  couponH5EnvelopeLimit,
  encodeCouponH5Envelope,
} from '../src/coupons/coupon-h5-envelope.js';
import { CouponH5Runtime } from '../src/coupons/coupon-h5-runtime.js';
import {
  CouponH5Controller,
  mountCouponH5JsonParser,
} from '../src/http/coupon-h5-controller.js';
import { PromotionsIdentity } from '../src/http/promotions-identity.js';
import {
  PromotionsConfigService,
  validatePromotionsConfiguration,
} from '../src/infrastructure/config/promotions-config.js';
import { createEnvironmentFixture } from './support/environment.js';

describe('H5 candidate HTTP boundary remains isolated', () => {
  let app: INestApplication;
  const fixture = createEnvironmentFixture();
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [PromotionsSvcModule],
    })
      .overrideProvider(PromotionsConfigService)
      .useValue(
        new PromotionsConfigService(
          validatePromotionsConfiguration(fixture.environment),
        ),
      )
      .compile();
    app = module.createNestApplication();
    await app.init();
  });
  afterAll(async () => {
    await app?.close();
    fixture.cleanup();
  });
  it('does not expose admission or operation reads before contract/G7 review', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/cupones/consumos')
      .send({})
      .expect(404);
    await request(app.getHttpServer())
      .post('/api/v1/cupones/restauraciones')
      .send({})
      .expect(404);
    await request(app.getHttpServer())
      .get(
        '/api/v1/cupones/operaciones/11111111-1111-4111-8111-111111111111?order_id=PED-1',
      )
      .expect(404);
  });
});

describe('Promotions H5 HTTP contract in isolation', () => {
  let app: INestApplication;
  const fixture = createEnvironmentFixture();
  const issuer = 'https://security.isolated.test/api/v1/auth';
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = 'coupon-h5-test-key';
  const operationId = randomUUID();
  const orderId = 'PED/H5 + 01';
  const body = {
    operation_id: operationId,
    order_id: orderId,
    coupon_code: 'ENTRENA5',
    channel_id: 'MARKETPLACE',
    customer_ref: randomUUID(),
    effective_at: '2026-11-21T16:00:00Z',
    reservation_id: randomUUID(),
    commercial_snapshot_ref: orderId,
  };
  const snapshot = {
    operation_id: operationId,
    order_id: orderId,
    operation_type: 'CONSUMIR_CUPON',
    status: 'ACCEPTED',
    accepted_at: body.effective_at,
    updated_at: body.effective_at,
    completed_at: null,
    result: null,
  };
  const operations = {
    admit: vi.fn<(admission: CouponH5Admission) => Promise<unknown>>(),
    get: vi.fn(),
  };
  const admissionAvailable = vi.fn();
  const consumePath = '/api/v1/cupones/consumos';
  const restorePath = '/api/v1/cupones/restauraciones';
  const statusPath = `/api/v1/cupones/operaciones/${operationId}`;
  const publicKeys = async () => [
    { ...keys.publicKey.export({ format: 'jwk' }), kid },
  ];

  function token(
    scope: string,
    sub = 'modulo-ventas',
    overrides: Record<string, unknown> = {},
  ) {
    const iat = Math.floor(Date.now() / 1000);
    const parts = [
      { alg: 'RS256', kid, typ: 'JWT' },
      {
        iss: issuer,
        sub,
        scope,
        iat,
        exp: iat + 600,
        jti: randomUUID(),
        aud: 'api-productos',
        tipo: 'servicio',
        ...overrides,
      },
    ].map((value) => Buffer.from(JSON.stringify(value)).toString('base64url'));
    const claims = parts.join('.');
    return `Bearer ${claims}.${sign('RSA-SHA256', Buffer.from(claims), keys.privateKey).toString('base64url')}`;
  }

  beforeAll(async () => {
    const config = new PromotionsConfigService(
      validatePromotionsConfiguration({
        ...fixture.environment,
        AUTH_ISSUER: issuer,
        AUTH_JWKS_URL: `${issuer}/.well-known/jwks.json`,
      }),
    );
    const identity = new PromotionsIdentity(config, publicKeys);
    const module = await Test.createTestingModule({
      controllers: [CouponH5Controller],
      providers: [
        { provide: PromotionsIdentity, useValue: identity },
        { provide: CouponH5Operations, useValue: operations },
        {
          provide: CouponH5Runtime,
          useValue: {
            enabled: true,
            assertAdmissionAvailable: admissionAvailable,
          },
        },
      ],
    }).compile();
    app = module.createNestApplication();
    mountCouponH5JsonParser(app);
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    fixture.cleanup();
  });

  beforeEach(() => {
    operations.admit.mockReset();
    operations.get.mockReset();
    admissionAvailable.mockReset();
  });

  it('returns the durable resource on first admission and reuses it on replay', async () => {
    operations.admit
      .mockResolvedValueOnce({ replay: false, snapshot })
      .mockResolvedValueOnce({ replay: true, snapshot })
      .mockRejectedValueOnce(new Error('IDEMPOTENCY_CONFLICT'));
    const correlationId = randomUUID();
    const admit = (payload = body) =>
      request(app.getHttpServer())
        .post(consumePath)
        .set('Authorization', token('cupones:consumir'))
        .set('Idempotency-Key', operationId)
        .set('X-Correlation-Id', correlationId)
        .send(payload);
    const accepted = await admit()
      .expect(202, snapshot)
      .expect('Retry-After', '2')
      .expect('X-Correlation-Id', correlationId);
    expect(accepted.headers.location).toBe(
      `${statusPath}?${new URLSearchParams({ order_id: orderId })}`,
    );
    await admit().expect(200, snapshot);
    expect(operations.admit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        actor: 'modulo-ventas',
        command: expect.objectContaining({
          operation_id: operationId,
          correlation_id: correlationId,
        }),
      }),
    );
    await admit({ ...body, coupon_code: 'OTHER' })
      .expect(409)
      .expect(({ body }) => expect(body.code).toBe('IDEMPOTENCY_CONFLICT'));
  });

  it('rejects invalid, expired, wrong-audience and human credentials before admission', async () => {
    const post = (credential: string) =>
      request(app.getHttpServer())
        .post(consumePath)
        .set('Authorization', credential)
        .set('Idempotency-Key', operationId)
        .send(body);
    await post('Bearer invalid.fixture.token').expect(401);
    await post(token('cupones:consumir', 'modulo-ventas', { exp: 1 })).expect(
      401,
    );
    await post(
      token('cupones:consumir', 'modulo-ventas', {
        aud: 'api-fixture-incorrecta',
      }),
    ).expect(401);
    await post(
      token('cupones:consumir', randomUUID(), {
        tipo: 'acceso',
        roles: ['GESTOR_COMERCIAL'],
      }),
    ).expect(403);
    expect(operations.admit).not.toHaveBeenCalled();
  });

  it('separates malformed keys, conflicting UUIDs and authorization failures', async () => {
    const post = () =>
      request(app.getHttpServer()).post(consumePath).send(body);
    await post().set('Idempotency-Key', operationId).expect(401);
    await post().set('Authorization', token('cupones:restaurar')).expect(403);
    await post()
      .set('Authorization', token('cupones:consumir', 'modulo-postventa'))
      .expect(403);
    await post()
      .set('Authorization', token('cupones:consumir'))
      .expect(400)
      .expect(({ body }) => expect(body.code).toBe('VALIDACION'));
    await post()
      .set('Authorization', token('cupones:consumir'))
      .set('Idempotency-Key', randomUUID())
      .expect(409)
      .expect(({ body }) => expect(body.code).toBe('IDEMPOTENCY_CONFLICT'));
    expect(operations.admit).not.toHaveBeenCalled();
  });

  it('sends the original consumption reference and cancellation timestamp to the durable admission', async () => {
    const restoration = {
      operation_id: randomUUID(),
      order_id: orderId,
      consumption_operation_id: operationId,
      cancellation_reason: 'ANULACION',
      cancelled_at: '2026-11-21T16:10:00Z',
    };
    operations.admit.mockResolvedValue({
      replay: false,
      snapshot: {
        ...snapshot,
        operation_id: restoration.operation_id,
        operation_type: 'RESTAURAR_CUPON',
      },
    });
    await request(app.getHttpServer())
      .post('/api/v1/cupones/restauraciones')
      .set('Authorization', token('cupones:restaurar'))
      .set('Idempotency-Key', restoration.operation_id)
      .send(restoration)
      .expect(202);
    expect(operations.admit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'RESTAURAR_CUPON',
        command: expect.objectContaining({
          data: expect.objectContaining({
            consumption_operation_id: operationId,
            cancelled_at: restoration.cancelled_at,
          }),
        }),
      }),
    );
  });

  it('serves snapshots by order and returns one indistinguishable 404 for missing or other orders', async () => {
    operations.get.mockImplementation(async (operation, order, actor) =>
      operation === operationId &&
      order === orderId &&
      actor === 'modulo-ventas'
        ? snapshot
        : undefined,
    );
    const correlationId = randomUUID();
    const get = (path: string, order: string) =>
      request(app.getHttpServer())
        .get(path)
        .set('Authorization', token('cupones:operaciones:leer'))
        .set('X-Correlation-Id', correlationId)
        .query({ order_id: order });
    await get(statusPath, orderId).expect(200, snapshot);
    const other = await get(statusPath, 'PED-AJENO')
      .expect(404)
      .expect('Content-Type', /application\/problem\+json/);
    const missing = await get(
      `/api/v1/cupones/operaciones/${randomUUID()}`,
      orderId,
    ).expect(404);
    const missingOrder = await request(app.getHttpServer())
      .get(statusPath)
      .set('Authorization', token('cupones:operaciones:leer'))
      .set('X-Correlation-Id', correlationId)
      .expect(400);
    const emptyOrder = await get(statusPath, '').expect(400);
    expect(missingOrder.body.code).toBe('VALIDACION');
    expect(emptyOrder.body.code).toBe('VALIDACION');
    expect(other.body).toEqual(missing.body);
    expect(other.body.code).toBe('OPERACION_CUPON_NO_ENCONTRADA');
  });

  it('does not report admission when storage returns a technical failure', async () => {
    operations.admit.mockRejectedValueOnce(new Error('storage fixture'));
    await request(app.getHttpServer())
      .post(consumePath)
      .set('Authorization', token('cupones:consumir'))
      .set('Idempotency-Key', operationId)
      .send(body)
      .expect(503)
      .expect(({ body }) => expect(body.code).toBe('SERVICIO_NO_DISPONIBLE'));
  });

  it('does not admit when the trusted worker has never started', async () => {
    admissionAvailable.mockImplementationOnce(() => {
      throw new Error('COUPON_H5_RUNTIME_UNAVAILABLE');
    });
    await request(app.getHttpServer())
      .post(consumePath)
      .set('Authorization', token('cupones:consumir'))
      .set('Idempotency-Key', operationId)
      .send(body)
      .expect(503);
    expect(operations.admit).not.toHaveBeenCalled();
  });

  it('enforces the complete UTF-8 envelope limit before consulting the runtime or storage', async () => {
    const correlationId = randomUUID();
    const restoration = {
      operation_id: randomUUID(),
      order_id: orderId,
      consumption_operation_id: operationId,
      cancellation_reason: 'a',
      cancelled_at: '2026-11-21T16:10:00Z',
    };
    const small = prepareCouponH5Admission(
      'RESTAURAR_CUPON',
      restoration,
      restoration.operation_id,
      'modulo-ventas',
      correlationId,
    );
    const remaining =
      couponH5EnvelopeLimit - encodeCouponH5Envelope(small.command).length;
    const multibyteCharacters = Math.floor((remaining - 1) / 2);
    const atLimit =
      'a' +
      'é'.repeat(multibyteCharacters) +
      'a'.repeat(remaining - multibyteCharacters * 2);
    const post = (reason: string) =>
      request(app.getHttpServer())
        .post(restorePath)
        .set('Authorization', token('cupones:restaurar'))
        .set('Idempotency-Key', restoration.operation_id)
        .set('X-Correlation-Id', correlationId)
        .send({ ...restoration, cancellation_reason: reason });
    operations.admit.mockResolvedValue({ replay: false, snapshot });
    await post(atLimit.slice(0, -1)).expect(202);
    await post(atLimit).expect(202);
    expect(
      encodeCouponH5Envelope(operations.admit.mock.calls[0][0].command),
    ).toHaveLength(couponH5EnvelopeLimit - 1);
    expect(
      encodeCouponH5Envelope(operations.admit.mock.calls[1][0].command),
    ).toHaveLength(couponH5EnvelopeLimit);
    operations.admit.mockClear();
    admissionAvailable.mockClear();
    for (const reason of [atLimit + 'a', atLimit + 'é'.repeat(16 * 1024)]) {
      await post(reason)
        .expect(400)
        .expect('Content-Type', /application\/problem\+json/)
        .expect('X-Correlation-Id', correlationId)
        .expect(({ body }) => expect(body.code).toBe('VALIDACION'));
    }
    expect(operations.admit).not.toHaveBeenCalled();
    expect(admissionAvailable).not.toHaveBeenCalled();
  });
});
