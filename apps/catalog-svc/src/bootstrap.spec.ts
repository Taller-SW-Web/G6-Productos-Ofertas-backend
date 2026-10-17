import { NestFactory } from '@nestjs/core';
import { createApplication } from './bootstrap.js';
import request from 'supertest';

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
