import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { describe, afterAll, beforeAll, expect, it } from 'vitest';
import { ApiGatewayModule } from '../src/api-gateway.module.js';
import {
  GATEWAY_SETTINGS,
  readGatewaySettings,
} from '../src/routing/gateway-settings.js';
import { createSignedIdentity } from './support/signed-identity.js';

/**
 * Gateway integration suite with simulated HTTP upstreams and local cryptographic JWT fixtures.
 * Does NOT execute real G7, G5, Azure, or microservice database persistence.
 * ESCRITA_NO_EJECUTADA in R2 pre-test phase.
 */
describe('API Gateway H5 R2 transversal G7 authorization and correlation (simulated HTTP upstreams)', () => {
  let app: INestApplication;
  let upstream: Server;
  let signed: ReturnType<typeof createSignedIdentity>;
  const receivedCalls: Array<{
    method: string;
    url: string;
    correlationId?: string;
    authorization?: string;
  }> = [];

  beforeAll(async () => {
    const tempSettings = readGatewaySettings({
      NODE_ENV: 'test',
      G6_SECURITY_MODE: 'G7_AUTHENTICATED',
      GATEWAY_G5_H5_ENABLED: 'true',
      AUTH_ISSUER: 'https://isolated.test/issuer',
      AUTH_JWKS_URL: 'https://isolated.test/jwks',
    });
    signed = createSignedIdentity(tempSettings);

    upstream = createServer((req, res) => {
      if (req.url === '/jwks') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ keys: [signed.key] }));
        return;
      }
      receivedCalls.push({
        method: req.method ?? '',
        url: req.url ?? '',
        correlationId: req.headers['x-correlation-id'] as string | undefined,
        authorization: req.headers.authorization,
      });
      res.setHeader('content-type', 'application/json');
      if (req.url === '/health/ready') {
        res.end(JSON.stringify({ status: 'ready' }));
        return;
      }
      res.end(JSON.stringify({ ok: true, items: [] }));
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const addr = upstream.address();
    if (!addr || typeof addr === 'string') throw new Error('No upstream port');
    const origin = `http://127.0.0.1:${addr.port}`;

    const settings = readGatewaySettings({
      NODE_ENV: 'test',
      G6_SECURITY_MODE: 'G7_AUTHENTICATED',
      GATEWAY_G5_H5_ENABLED: 'true',
      AUTH_ISSUER: 'https://isolated.test/issuer',
      AUTH_JWKS_URL: `${origin}/jwks`,
      GATEWAY_CATALOG_SVC_URL: origin,
      GATEWAY_TAXONOMY_SVC_URL: origin,
      GATEWAY_PRICING_SVC_URL: origin,
      GATEWAY_PRICE_AUDIT_SVC_URL: origin,
      GATEWAY_PROMOTIONS_SVC_URL: origin,
      GATEWAY_COMBOS_SVC_URL: origin,
      GATEWAY_INVENTORY_SVC_URL: origin,
      GATEWAY_BULK_SVC_URL: origin,
      GATEWAY_CATALOG_SVC_READINESS_PATH: '/health/ready',
      GATEWAY_TAXONOMY_SVC_READINESS_PATH: '/health/ready',
      GATEWAY_PRICING_SVC_READINESS_PATH: '/health/ready',
      GATEWAY_PRICE_AUDIT_SVC_READINESS_PATH: '/health/ready',
      GATEWAY_PROMOTIONS_SVC_READINESS_PATH: '/health/ready',
      GATEWAY_COMBOS_SVC_READINESS_PATH: '/health/ready',
      GATEWAY_INVENTORY_SVC_READINESS_PATH: '/health/ready',
      GATEWAY_BULK_SVC_READINESS_PATH: '/health/ready',
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

  afterAll(async () => {
    await app?.close();
    if (upstream) {
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });

  it('rejects unauthenticated requests across all 8 services and SEO routes with 401', async () => {
    const routes = [
      '/api/v1/productos',
      '/api/v1/categorias',
      '/api/v1/seo/electronica',
      '/api/v1/seo/resoluciones/viejo-slug',
      '/api/v1/precios?skus=SKU-1',
      '/api/v1/auditoria-precios',
      '/api/v1/promociones',
      '/api/v1/combos',
      '/api/v1/inventario/disponibilidad?skus=SKU-1',
      '/api/v1/carga-masiva/productos/plantilla?formato=CSV',
    ];
    for (const path of routes) {
      const res = await request(app.getHttpServer()).get(path).expect(401);
      expect(res.body.code).toBe('TOKEN_INVALIDO');
    }
  });

  it('authorizes G1 Marketplace, G3 Chatbot and G5 Ventas service tokens only on their contractual operations and propagates X-Correlation-Id', async () => {
    const g1Token = signed.token({
      tipo: 'servicio',
      sub: 'modulo-marketplace',
      aud: 'api-productos',
      scope: 'catalogo:leer',
    });
    const correlationId = randomUUID();
    await request(app.getHttpServer())
      .get('/api/v1/seo/electronica')
      .set('Authorization', `Bearer ${g1Token}`)
      .set('X-Correlation-Id', correlationId)
      .expect(200);
    expect(receivedCalls.at(-1)?.correlationId).toBe(correlationId);

    const g3Token = signed.token({
      tipo: 'servicio',
      sub: 'modulo-chatbot',
      aud: 'api-productos',
      scope: 'promociones:evaluar',
    });
    await request(app.getHttpServer())
      .post('/api/v1/promociones/evaluar')
      .set('Authorization', `Bearer ${g3Token}`)
      .send({ channel_id: 'CHATBOT', items: [{ sku: 'SKU-1', quantity: 1 }] })
      .expect(200);

    // G3 must be denied (403) on G5 coupon consumption
    await request(app.getHttpServer())
      .post('/api/v1/cupones/consumir')
      .set('Authorization', `Bearer ${g3Token}`)
      .set('Idempotency-Key', randomUUID())
      .send({})
      .expect(403);

    const g5Token = signed.token({
      tipo: 'servicio',
      sub: 'modulo-ventas',
      aud: 'api-productos',
      scope: 'inventario:reservas:estado:leer',
    });
    await request(app.getHttpServer())
      .get(`/api/v1/inventario/reservas/${randomUUID()}/estado?order_id=ORD-1`)
      .set('Authorization', `Bearer ${g5Token}`)
      .expect(200);
  });

  it('reports complete readiness across all 8 services', async () => {
    const res = await request(app.getHttpServer())
      .get('/health/ready')
      .expect(200);
    expect(res.body.status).toBe('ready');
    expect(res.body.coverage).toBe('complete');
  });
});
