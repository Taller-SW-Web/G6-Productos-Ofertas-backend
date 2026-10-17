import { Test } from '@nestjs/testing';
import request from 'supertest';
import { TaxonomySvcModule } from '../src/taxonomy-svc.module.js';
import { TAXONOMY_REPOSITORY } from '../src/taxonomy.repository.js';

describe('Taxonomy readiness versus liveness', () => {
  it('checks repository readiness for each request and recovers', async () => {
    let ready = true;
    const module = await Test.createTestingModule({
      imports: [TaxonomySvcModule],
    })
      .overrideProvider(TAXONOMY_REPOSITORY)
      .useValue({ readiness: async () => ready })
      .compile();
    const app = module.createNestApplication();
    await app.init();
    try {
      await request(app.getHttpServer()).get('/health/ready').expect(200);
      ready = false;
      await request(app.getHttpServer()).get('/health/ready').expect(503);
      await request(app.getHttpServer()).get('/health').expect(200);
      ready = true;
      await request(app.getHttpServer()).get('/health/ready').expect(200);
    } finally {
      await app.close();
    }
  });
});
