import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { PricingSvcModule } from './../src/pricing-svc.module.js';
import { PricingReadiness } from '../src/health/pricing-readiness.js';

describe('PricingSvcController (e2e)', () => {
  let app: INestApplication<App>;
  const check = vi.fn<() => Promise<boolean>>();
  const env = {
    NODE_ENV: 'test',
    PRICING_SVC_PORT: '3002',
    DATABASE_URL: 'postgresql://pricing:fixture@127.0.0.1:1/fixture',
  };

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [PricingSvcModule.forRoot(env)],
    })
      .overrideProvider(PricingReadiness)
      .useValue({ check })
      .compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  it('/health (GET)', () => {
    return request(app.getHttpServer()).get('/health').expect(200).expect({
      status: 'ok',
      service: 'pricing-svc',
    });
  });

  it('liveness sigue en 200 mientras readiness es 503; vuelve a 200 al recuperarse', async () => {
    check.mockResolvedValue(false);
    await request(app.getHttpServer()).get('/health').expect(200);
    await request(app.getHttpServer())
      .get('/health/live')
      .expect(200)
      .expect({ status: 'ok', service: 'pricing-svc' });
    expect(check).not.toHaveBeenCalled();
    await request(app.getHttpServer())
      .get('/health/ready')
      .expect(503)
      .expect({ status: 'not_ready', service: 'pricing-svc' });
    check.mockResolvedValue(true);
    await request(app.getHttpServer())
      .get('/health/ready')
      .expect(200)
      .expect({ status: 'ready', service: 'pricing-svc' });
  });

  it('el proveedor real responde 503 ante PostgreSQL inaccesible, sin exponer la URL', async () => {
    const module = await Test.createTestingModule({
      imports: [PricingSvcModule.forRoot(env)],
    }).compile();
    const realApp = module.createNestApplication();
    try {
      await realApp.init();
      await request(realApp.getHttpServer()).get('/health').expect(200);
      const response = await request(realApp.getHttpServer())
        .get('/health/ready')
        .expect(503);
      expect(response.body).toEqual({
        status: 'not_ready',
        service: 'pricing-svc',
      });
      expect(response.text).not.toContain(env.DATABASE_URL);
    } finally {
      await realApp.close();
    }
  });

  afterEach(async () => {
    check.mockReset();
    await app.close();
  });
});
