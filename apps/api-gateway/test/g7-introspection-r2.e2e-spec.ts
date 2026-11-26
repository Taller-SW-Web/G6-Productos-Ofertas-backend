import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { describe, afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { ApiGatewayModule } from '../src/api-gateway.module.js';
import {
  GATEWAY_SETTINGS,
  readGatewaySettings,
} from '../src/routing/gateway-settings.js';
import { createSignedIdentity } from './support/signed-identity.js';

/**
 * Gateway introspection integration suite for Pricing sensitive operations (P0-AUTH-03).
 * ESCRITA_NO_EJECUTADA in R2 pre-test phase.
 */
describe('API Gateway P0-AUTH-03 G7 introspection scenarios (ESCRITA_NO_EJECUTADA)', () => {
  let app: INestApplication;
  let upstream: Server;
  let signed: ReturnType<typeof createSignedIdentity>;
  let origin = '';
  let nextIntrospectionResponse: { status: number; body: Record<string, unknown> } = {
    status: 200,
    body: { activo: true },
  };
  let nextTokenResponse: { status: number; body: Record<string, unknown> } | null = null;
  let upstreamPricingCalls = 0;
  let tokenCalls = 0;
  let introspectionCalls = 0;

  beforeAll(async () => {
    const tempSettings = readGatewaySettings({
      NODE_ENV: 'test',
      G6_SECURITY_MODE: 'G7_AUTHENTICATED',
      GATEWAY_G5_H5_ENABLED: 'true',
      AUTH_ISSUER: 'http://127.0.0.1:1/issuer',
      AUTH_JWKS_URL: 'http://127.0.0.1:1/jwks',
    });
    signed = createSignedIdentity(tempSettings);

    upstream = createServer(async (req, res) => {
      if (req.url === '/jwks') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ keys: [signed.key] }));
        return;
      }
      if (req.url === '/api/v1/auth/token' && req.method === 'POST') {
        tokenCalls += 1;
        if (nextTokenResponse) {
          res.statusCode = nextTokenResponse.status;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(nextTokenResponse.body));
          return;
        }
        const accessToken = signed.token({
          iss: `${origin}/issuer`,
          tipo: 'servicio',
          sub: 'modulo-productos',
          aud: ['api-seguridad'],
          scope: 'tokens:introspeccion',
        });
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            accessToken,
            tokenType: 'Bearer',
            expiresIn: 600,
            scopes: ['tokens:introspeccion'],
          }),
        );
        return;
      }
      if (req.url === '/api/v1/auth/introspeccion' && req.method === 'POST') {
        introspectionCalls += 1;
        res.statusCode = nextIntrospectionResponse.status;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(nextIntrospectionResponse.body));
        return;
      }
      if (req.url === '/health/ready') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ status: 'ready' }));
        return;
      }
      upstreamPricingCalls += 1;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const addr = upstream.address();
    if (!addr || typeof addr === 'string') throw new Error('No port');
    origin = `http://127.0.0.1:${addr.port}`;

    const settings = readGatewaySettings({
      NODE_ENV: 'test',
      G6_SECURITY_MODE: 'G7_AUTHENTICATED',
      GATEWAY_G5_H5_ENABLED: 'true',
      AUTH_ISSUER: `${origin}/issuer`,
      AUTH_JWKS_URL: `${origin}/jwks`,
      GATEWAY_SERVICE_TOKEN_URL: `${origin}/api/v1/auth/token`,
      GATEWAY_SERVICE_CLIENT_SECRET: 'e2e-gateway-secret',
      GATEWAY_PRICING_SVC_URL: origin,
      GATEWAY_PRICING_SVC_READINESS_PATH: '/health/ready',
    });

    const moduleRef = await Test.createTestingModule({
      imports: [ApiGatewayModule],
    })
      .overrideProvider(GATEWAY_SETTINGS)
      .useValue(settings)
      .compile();

    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
  });

  beforeEach(() => {
    nextTokenResponse = null;
    upstreamPricingCalls = 0;
    tokenCalls = 0;
    introspectionCalls = 0;
  });

  afterAll(async () => {
    await app?.close();
    if (upstream) {
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });

  function userToken(sub = randomUUID()) {
    return {
      sub,
      jwt: signed.token({
        iss: `${origin}/issuer`,
        tipo: 'acceso',
        sub,
        roles: ['GESTOR_COMERCIAL'],
      }),
    };
  }

  const validPricingPatchBody = {
    accionPrecioOferta: 'CONSERVAR',
    priceVersion: 0,
    precioRegular: 99.5,
    moneda: 'PEN',
    motivoCambio: 'E2E_INTROSPECTION',
  };

  it('permits Pricing sensitive PATCH when introspection returns active matching user', async () => {
    const { sub, jwt } = userToken();
    nextIntrospectionResponse = {
      status: 200,
      body: {
        activo: true,
        sub,
        tipo: 'acceso',
        roles: ['GESTOR_COMERCIAL'],
        permisos: ['precios:escribir'],
      },
    };
    await request(app.getHttpServer())
      .patch(`/api/v1/precios/productos/${randomUUID()}`)
      .set('Authorization', `Bearer ${jwt}`)
      .set('Idempotency-Key', randomUUID())
      .send(validPricingPatchBody)
      .expect(200);
    expect(introspectionCalls).toBe(1);
    expect(upstreamPricingCalls).toBe(1);
  });

  it.each([
    ['TOKEN_VENCIDO'],
    ['TOKEN_REVOCADO'],
    ['USUARIO_BLOQUEADO'],
    ['USUARIO_INACTIVO'],
  ])('rejects with 401 when introspection returns inactive motivo=%s', async (motivo) => {
    const { jwt } = userToken();
    nextIntrospectionResponse = {
      status: 200,
      body: { activo: false, motivo },
    };
    await request(app.getHttpServer())
      .patch(`/api/v1/precios/productos/${randomUUID()}`)
      .set('Authorization', `Bearer ${jwt}`)
      .set('Idempotency-Key', randomUUID())
      .send(validPricingPatchBody)
      .expect(401);
    expect(introspectionCalls).toBe(1);
    expect(upstreamPricingCalls).toBe(0);
  });

  it('rejects with 401 when introspection sub does not match JWT sub', async () => {
    const { jwt } = userToken();
    nextIntrospectionResponse = {
      status: 200,
      body: {
        activo: true,
        sub: randomUUID(),
        tipo: 'acceso',
        roles: ['GESTOR_COMERCIAL'],
        permisos: ['precios:escribir'],
      },
    };
    await request(app.getHttpServer())
      .patch(`/api/v1/precios/productos/${randomUUID()}`)
      .set('Authorization', `Bearer ${jwt}`)
      .set('Idempotency-Key', randomUUID())
      .send(validPricingPatchBody)
      .expect(401);
    expect(introspectionCalls).toBe(1);
    expect(upstreamPricingCalls).toBe(0);
  });

  it('fails closed (503) when G7 provider fails temporarily, and isolated instance rejects wrong client/scope without cache reuse', async () => {
    const { jwt } = userToken();

    nextIntrospectionResponse = { status: 503, body: { code: 'UNAVAILABLE' } };
    await request(app.getHttpServer())
      .patch(`/api/v1/precios/productos/${randomUUID()}`)
      .set('Authorization', `Bearer ${jwt}`)
      .set('Idempotency-Key', randomUUID())
      .send(validPricingPatchBody)
      .expect(503);
    expect(introspectionCalls).toBe(1);
    expect(upstreamPricingCalls).toBe(0);

    // Instancia Gateway aislada (sin caché previa de serviceTokenCache)
    const isolatedSettings = readGatewaySettings({
      NODE_ENV: 'test',
      G6_SECURITY_MODE: 'G7_AUTHENTICATED',
      GATEWAY_G5_H5_ENABLED: 'true',
      AUTH_ISSUER: `${origin}/issuer`,
      AUTH_JWKS_URL: `${origin}/jwks`,
      GATEWAY_SERVICE_TOKEN_URL: `${origin}/api/v1/auth/token`,
      GATEWAY_SERVICE_CLIENT_SECRET: 'e2e-gateway-secret',
      GATEWAY_PRICING_SVC_URL: origin,
      GATEWAY_PRICING_SVC_READINESS_PATH: '/health/ready',
    });
    const isolatedModule = await Test.createTestingModule({
      imports: [ApiGatewayModule],
    })
      .overrideProvider(GATEWAY_SETTINGS)
      .useValue(isolatedSettings)
      .compile();
    const isolatedApp = isolatedModule.createNestApplication({ logger: false });
    await isolatedApp.init();

    tokenCalls = 0;
    introspectionCalls = 0;
    nextTokenResponse = {
      status: 200,
      body: {
        accessToken: signed.token({
          iss: `${origin}/issuer`,
          tipo: 'servicio',
          sub: 'otro-cliente',
          aud: ['api-seguridad'],
          scope: 'catalogo:leer',
        }),
        tokenType: 'Bearer',
        expiresIn: 600,
        scopes: ['catalogo:leer'],
      },
    };
    try {
      await request(isolatedApp.getHttpServer())
        .patch(`/api/v1/precios/productos/${randomUUID()}`)
        .set('Authorization', `Bearer ${jwt}`)
        .set('Idempotency-Key', randomUUID())
        .send(validPricingPatchBody)
        .expect(503);
      expect(tokenCalls).toBe(1);
      expect(introspectionCalls).toBe(0);
      expect(upstreamPricingCalls).toBe(0);
    } finally {
      await isolatedApp.close();
    }
  });
});
