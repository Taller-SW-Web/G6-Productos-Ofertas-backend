import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { Database } from '../src/database.js';

describe('Catalog readiness versus liveness', () => {
  it('keeps commercial readiness closed with reachable PostgreSQL but no eligibility source', async () => {
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(Database)
      .useValue({ verifyIdentity: async () => undefined })
      .compile();
    const app = module.createNestApplication();
    await app.init();
    try {
      await request(app.getHttpServer()).get('/health').expect(200);
      const response = await request(app.getHttpServer())
        .get('/health/ready')
        .expect(503);
      expect(response.body.code).toBe('SERVICIO_NO_DISPONIBLE');
    } finally {
      await app.close();
    }
  });
});
