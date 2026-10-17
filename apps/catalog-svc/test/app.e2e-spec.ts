import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module.js';
import { CATALOG_DATABASE } from './../src/readiness.js';

describe('AppController (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  it('/health (GET)', () => {
    return request(app.getHttpServer()).get('/health').expect(200).expect({
      status: 'ok',
      service: 'catalog-svc',
    });
  });

  it('/health/live remains alive while readiness is unavailable', async () => {
    const unavailable = await request(app.getHttpServer())
      .get('/health/ready')
      .expect(503);
    expect(unavailable.body).toMatchObject({
      status: 503,
      code: 'SERVICIO_NO_DISPONIBLE',
    });
    await request(app.getHttpServer()).get('/health/live').expect(200).expect({
      status: 'ok',
      service: 'catalog-svc',
    });
  });

  it('reflects dependency availability and loss with an isolated test adapter', async () => {
    const check = vi.fn().mockResolvedValue(undefined);
    const fixture = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(CATALOG_DATABASE)
      .useValue({ check })
      .compile();
    const isolated = fixture.createNestApplication();
    await isolated.init();
    try {
      await request(isolated.getHttpServer())
        .get('/health/ready')
        .expect(200)
        .expect({
          status: 'ready',
          service: 'catalog-svc',
        });
      check.mockRejectedValue(new Error('fixture-secret'));
      const response = await request(isolated.getHttpServer())
        .get('/health/ready')
        .expect(503);
      expect(response.text).not.toContain('fixture-secret');
      await request(isolated.getHttpServer()).get('/health').expect(200);
    } finally {
      await isolated.close();
    }
  });

  afterEach(async () => {
    await app.close();
  });
});
