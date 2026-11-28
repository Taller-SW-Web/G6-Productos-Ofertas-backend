import { createSign, generateKeyPairSync, randomUUID } from 'node:crypto';
import { Test, type TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { BulkSvcModule } from '../src/bulk-svc.module.js';
import {
  BULK_ENVIRONMENT,
  BULK_READINESS_POOL,
  parseBulkEnvironment,
} from '../src/config/bulk-environment.js';
import { BulkImportService } from '../src/bulk-import.service.js';
import { BulkDomainError } from '../src/domain/bulk.domain-error.js';
import { BulkProblemFilter } from '../src/http/bulk-problem.filter.js';

/**
 * H29 — Regresión HTTP real de BulkSvcController + BulkUserBearerGuard sobre las
 * dos operaciones originales reproducidas en APIM Chile:
 *   1. GET /api/v1/carga-masiva/productos/plantilla?formato=CSV -> 200 OK
 *   2. GET /api/v1/carga-masiva/productos/importaciones/{id-inexistente} -> 404 contractual
 */
describe('H29 — Bulk HTTP auth regressions (plantilla CSV 200 y lote inexistente 404)', () => {
  let app: INestApplication<App>;
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  const { privateKey: wrongPrivateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  const issuer = 'https://g7-h29.local/issuer';
  const nonExistentBatchId = '00000000-0000-4000-8000-000000000405';

  function signJwt(
    overrides: Record<string, unknown> = {},
    key = privateKey,
  ): string {
    const encode = (value: object) =>
      Buffer.from(JSON.stringify(value)).toString('base64url');
    const header = encode({ alg: 'RS256', typ: 'JWT' });
    const now = Math.floor(Date.now() / 1000);
    const payload: Record<string, unknown> = {
      iss: issuer,
      sub: randomUUID(),
      tipo: 'acceso',
      iat: now,
      exp: now + 600,
      jti: randomUUID(),
      roles: ['GESTOR_COMERCIAL'],
      ...overrides,
    };
    if (payload.aud === undefined) delete payload.aud;
    const claims = encode(payload);
    const signer = createSign('RSA-SHA256');
    signer.update(`${header}.${claims}`);
    return `${header}.${claims}.${signer.sign(key, 'base64url')}`;
  }

  beforeAll(async () => {
    process.env.G6_SECURITY_MODE = 'G7_AUTHENTICATED';
    process.env.G7_JWT_ISSUER = issuer;
    process.env.G7_JWT_PUBLIC_KEY = publicKey
      .export({ type: 'spki', format: 'pem' })
      .toString();

    const config = parseBulkEnvironment({
      NODE_ENV: 'test',
      BULK_SVC_PORT: '3008',
    });

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [BulkSvcModule],
    })
      .overrideProvider(BULK_ENVIRONMENT)
      .useValue(config)
      .overrideProvider(BULK_READINESS_POOL)
      .useValue(null)
      .overrideProvider(BulkImportService)
      .useValue({
        getSnapshot: vi.fn(async (batchId: string) => {
          throw new BulkDomainError(
            'BATCH_NOT_FOUND',
            `Lote ${batchId} no encontrado`,
          );
        }),
      })
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalFilters(new BulkProblemFilter());
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    delete process.env.G6_SECURITY_MODE;
    delete process.env.G7_JWT_ISSUER;
    delete process.env.G7_JWT_PUBLIC_KEY;
  });

  it('PM-030: GET /api/v1/carga-masiva/productos/plantilla?formato=CSV devuelve 200 text/csv con JWT humano G7 sin aud', async () => {
    const tokenNoAud = signJwt({ aud: undefined });
    const res = await request(app.getHttpServer())
      .get('/api/v1/carga-masiva/productos/plantilla?formato=CSV')
      .set('Authorization', `Bearer ${tokenNoAud}`)
      .expect(200);
    expect(String(res.headers['content-type']).toLowerCase()).toContain(
      'text/csv',
    );
    expect(res.text.trim().length).toBeGreaterThan(10);
  });

  it('PM-031: GET /api/v1/carga-masiva/productos/importaciones/{id-inexistente} devuelve 404 contractual con JWT humano sin aud', async () => {
    const tokenNoAud = signJwt({ aud: undefined });
    const res = await request(app.getHttpServer())
      .get(`/api/v1/carga-masiva/productos/importaciones/${nonExistentBatchId}`)
      .set('Authorization', `Bearer ${tokenNoAud}`)
      .expect(404);
    expect(res.body).toMatchObject({
      code: 'LOTE_NO_ENCONTRADO',
    });
  });

  it('rechaza con 401 tokens inválidos, expirados, firma incorrecta, issuer incorrecto, aud inválida y token M2M (tipo=servicio) en ambas operaciones', async () => {
    const invalidTokens = [
      'not-a-valid-jwt',
      signJwt({ exp: Math.floor(Date.now() / 1000) - 30 }),
      signJwt({}, wrongPrivateKey),
      signJwt({ iss: 'https://otro-issuer.invalid' }),
      signJwt({ aud: 'api-otra' }),
      signJwt({
        tipo: 'servicio',
        aud: 'api-productos',
        scope: 'catalogo:leer',
      }),
    ];

    for (const badToken of invalidTokens) {
      await request(app.getHttpServer())
        .get('/api/v1/carga-masiva/productos/plantilla?formato=CSV')
        .set('Authorization', `Bearer ${badToken}`)
        .expect(401);
      await request(app.getHttpServer())
        .get(
          `/api/v1/carga-masiva/productos/importaciones/${nonExistentBatchId}`,
        )
        .set('Authorization', `Bearer ${badToken}`)
        .expect(401);
    }
  });

  it('rechaza con 403 SCOPE_INSUFICIENTE cuando el usuario humano carece del rol GESTOR_COMERCIAL en ambas operaciones', async () => {
    const restrictedToken = signJwt({ roles: ['CONSULTA_BASICA'] });
    await request(app.getHttpServer())
      .get('/api/v1/carga-masiva/productos/plantilla?formato=CSV')
      .set('Authorization', `Bearer ${restrictedToken}`)
      .expect(403);
    await request(app.getHttpServer())
      .get(`/api/v1/carga-masiva/productos/importaciones/${nonExistentBatchId}`)
      .set('Authorization', `Bearer ${restrictedToken}`)
      .expect(403);
  });
});
