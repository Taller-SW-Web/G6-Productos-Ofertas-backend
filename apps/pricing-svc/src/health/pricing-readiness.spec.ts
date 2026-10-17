import { Pool } from 'pg';
import { PricingReadiness } from './pricing-readiness.js';
import { PricingDatabase } from '../persistence/pricing.database.js';
import { validateEnvironment } from '../config/environment.js';

vi.mock('pg', () => ({
  Pool: vi.fn(
    class {
      query = vi.fn();
      end = vi.fn();
      on = vi.fn();
    },
  ),
}));

describe('PricingReadiness', () => {
  it('consulta únicamente Pricing, falla cerrado y libera el pool', async () => {
    const database = new PricingDatabase({
      nodeEnv: 'test',
      port: 3002,
      databaseUrl: 'postgresql://pricing:fixture@localhost/fixture',
      databaseSsl: false,
    });
    const readiness = new PricingReadiness(database);
    const pool = vi.mocked(Pool).mock.instances.at(-1)!;
    expect(Pool).toHaveBeenLastCalledWith(
      expect.objectContaining({
        max: 2,
        ssl: false,
        connectionTimeoutMillis: 2000,
        query_timeout: 2000,
        statement_timeout: 2000,
      }),
    );
    vi.mocked(pool.query).mockResolvedValueOnce({ rows: [] });
    expect(await readiness.check()).toBe(true);
    expect(pool.query).toHaveBeenCalledWith(
      'SELECT 1 FROM pricing.prices LIMIT 0',
    );
    vi.mocked(pool.query).mockRejectedValueOnce(
      new Error('fixture-sensitive-value'),
    );
    expect(await readiness.check()).toBe(false);
    await database.onApplicationShutdown();
    expect(pool.end).toHaveBeenCalledOnce();
    expect(pool.on).toHaveBeenCalledWith('error', expect.any(Function));
  });

  it('pasa TLS explícito al pool sin parámetros URL que puedan degradarlo', async () => {
    const config = validateEnvironment({
      NODE_ENV: 'production',
      PRICING_SVC_PORT: '3002',
      DATABASE_URL:
        'postgresql://pricing:fixture@db.example.invalid/fixture?sslmode=verify-full',
    });
    const database = new PricingDatabase(config);
    expect(Pool).toHaveBeenLastCalledWith(
      expect.objectContaining({
        connectionString:
          'postgresql://pricing:fixture@db.example.invalid/fixture',
        ssl: expect.objectContaining({
          rejectUnauthorized: true,
          checkServerIdentity: expect.any(Function),
        }),
      }),
    );
    await database.onApplicationShutdown();
  });
});
