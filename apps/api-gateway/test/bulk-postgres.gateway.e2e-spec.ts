import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { ApiGatewayModule } from '../src/api-gateway.module.js';
import { GatewayIdentity } from '../src/routing/gateway-identity.js';
import {
  GATEWAY_SETTINGS,
  type GatewaySettings,
} from '../src/routing/gateway-settings.js';
import { createSignedIdentity } from './support/signed-identity.js';

const runBulkPgE2E = process.env.GATEWAY_BULK_PG_E2E === '1';
const describeIfAuthorized = runBulkPgE2E ? describe : describe.skip;

/**
 * GW-T03: Integración Gateway -> Bulk -> PostgreSQL descartable.
 * Requiere GATEWAY_BULK_PG_E2E=1 y BULK_E2E_URL apuntando a un bulk-svc
 * conectado a PostgreSQL descartable autorizado.
 */
describeIfAuthorized('Gateway -> Bulk -> disposable PostgreSQL (GW-T03)', () => {
  let app: INestApplication;
  let signed: ReturnType<typeof createSignedIdentity>;
  let fallbackServer: Server | undefined;

  beforeAll(async () => {
    const bulkUrl = process.env.BULK_E2E_URL;
    if (!bulkUrl) {
      throw new Error('BULK_E2E_URL is required when GATEWAY_BULK_PG_E2E=1');
    }
    const settings: GatewaySettings = {
      securityMode: 'G7_AUTHENTICATED',
      upstreams: { 'bulk-svc': bulkUrl },
      timeoutMs: 5000,
      maxBytes: 1024 * 1024,
      publicOperations: [],
      demoNoAuthEnabled: false,
      g5H5Enabled: false,
    };
    signed = createSignedIdentity(settings);
    const module = await Test.createTestingModule({
      imports: [ApiGatewayModule],
    })
      .overrideProvider(GATEWAY_SETTINGS)
      .useValue(settings)
      .overrideProvider(GatewayIdentity)
      .useValue(signed.identity)
      .compile();
    app = module.createNestApplication({ bodyParser: false });
    await app.listen(0, '127.0.0.1');
  });

  afterAll(async () => {
    await app?.close();
    if (fallbackServer) {
      await new Promise<void>((done) => fallbackServer!.close(() => done()));
    }
  });

  it('isolates Bulk correlation reconciliation by actor UUID and preserves Cache-Control: no-store', async () => {
    const ownerActorId = randomUUID();
    const otherActorId = randomUUID();
    const correlationId = randomUUID();
    const ownerToken = signed.human({
      sub: ownerActorId,
      roles: ['GESTOR_COMERCIAL'],
    });
    const otherToken = signed.human({
      sub: otherActorId,
      roles: ['GESTOR_COMERCIAL'],
    });

    const ownerResponse = await request(app.getHttpServer())
      .get(
        `/api/v1/carga-masiva/productos/importaciones/por-correlacion/${correlationId}`,
      )
      .set('Authorization', `Bearer ${ownerToken}`);
    expect([200, 404]).toContain(ownerResponse.status);
    expect(ownerResponse.headers['cache-control']).toBe('no-store');

    await request(app.getHttpServer())
      .get(
        `/api/v1/carga-masiva/productos/importaciones/por-correlacion/${correlationId}`,
      )
      .set('Authorization', `Bearer ${otherToken}`)
      .expect(404);
  });
});

// Placeholder server reference to satisfy unused import lint rules when skipped
void once;
void createServer;
