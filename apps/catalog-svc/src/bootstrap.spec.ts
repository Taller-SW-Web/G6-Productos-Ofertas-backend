import { NestFactory } from '@nestjs/core';
import { createApplication } from './bootstrap.js';
import request from 'supertest';
import { Test } from '@nestjs/testing';
import { AppModule } from './app.module.js';
import { CatalogConfig } from './config.js';
import { PostgresReadiness } from './postgres-readiness.js';
import { ReadinessController as CommercialReadinessController } from './readiness.controller.js';
import { CATALOG_DATABASE, type CatalogDatabase } from './readiness.js';

const env = {
  NODE_ENV: 'test',
  CATALOG_SVC_PORT: '3001',
  DATABASE_URL: 'postgres://catalog_app:fixture-secret@localhost/catalog',
};

describe('bootstrap configuration', () => {
  afterEach(() => vi.restoreAllMocks());

  it('rejects invalid configuration before creating the application', async () => {
    const create = vi.spyOn(NestFactory, 'create');
    await expect(createApplication({})).rejects.toThrow('Configuracion');
    expect(create).not.toHaveBeenCalled();
  });

  it('creates and starts HTTP with valid config without leaking secrets', async () => {
    const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const { app, config } = await createApplication(env);
    try {
      await app.listen(0, '127.0.0.1');
      expect(await app.getUrl()).toMatch(/^http:\/\/127.0.0.1:/);
      expect(config.port).toBe(3001);
      await request(await app.getUrl())
        .get('/health/live')
        .set('X-Correlation-Id', 'fixture-correlation')
        .expect('X-Correlation-Id', 'fixture-correlation')
        .expect(200);
      const response = await request(await app.getUrl()).get('/health');
      expect(response.headers['x-correlation-id']).toMatch(/^[a-f0-9-]{36}$/);
      expect(JSON.stringify(output.mock.calls)).not.toContain('fixture-secret');
    } finally {
      await app.close();
    }
  });
});

describe('readiness after integrating master', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(['none', 'database', 'commercial'] as const)(
    'requires both database and commercial checks (failure: %s)',
    async (failure) => {
      const database = vi
        .spyOn(PostgresReadiness.prototype, 'check')
        .mockResolvedValue(undefined);
      const commercial = vi
        .fn()
        .mockResolvedValue({ status: 'ready', service: 'catalog-svc' });
      if (failure === 'database')
        database.mockRejectedValue(new Error('fixture-database-failure'));
      if (failure === 'commercial')
        commercial.mockRejectedValue(new Error('fixture-commercial-failure'));
      const module = await Test.createTestingModule({
        imports: [AppModule.forRoot(new CatalogConfig(env))],
      })
        .overrideProvider(CommercialReadinessController)
        .useValue({ ready: commercial })
        .compile();
      try {
        const readiness = module.get<CatalogDatabase>(CATALOG_DATABASE);
        if (failure === 'none')
          await expect(readiness.check()).resolves.toBeUndefined();
        else await expect(readiness.check()).rejects.toThrow();
        expect(database).toHaveBeenCalledOnce();
        expect(commercial).toHaveBeenCalledTimes(
          failure === 'database' ? 0 : 1,
        );
      } finally {
        await module.close();
      }
    },
  );
});
