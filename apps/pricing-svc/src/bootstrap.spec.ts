import { NestFactory } from '@nestjs/core';
import { createApplication, startPricing } from './bootstrap.js';

vi.mock('node:fs', () => ({ existsSync: () => false }));

describe('Pricing bootstrap', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    process.exitCode = 0;
  });

  it('rechaza configuración inválida antes de crear Nest o abrir puertos', async () => {
    const create = vi.spyOn(NestFactory, 'create');
    await expect(
      createApplication({ NODE_ENV: 'test', PRICING_SVC_PORT: '3002' }),
    ).rejects.toThrow('DATABASE_URL');
    expect(create).not.toHaveBeenCalled();
  });

  it('falla el arranque con código 1 y logs JSON sin el valor inválido', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('PRICING_SVC_PORT', 'fixture-sensitive-value');
    const output = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    await startPricing();
    expect(process.exitCode).toBe(1);
    const logs = output.mock.calls.map(([value]) => String(value)).join('');
    expect(logs).not.toContain('fixture-sensitive-value');
    expect(logs).toContain('PRICING_SVC_PORT');
    expect(JSON.parse(logs).message.service).toBe('pricing-svc');
  });
});
