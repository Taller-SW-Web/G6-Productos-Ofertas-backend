import { Pool } from 'pg';
import { PricingReadiness } from './pricing-readiness.js';

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
    const readiness = new PricingReadiness({
      nodeEnv: 'test',
      port: 3002,
      databaseUrl: 'postgresql://pricing:fixture@localhost/fixture',
    });
    const pool = vi.mocked(Pool).mock.instances.at(-1)!;
    expect(Pool).toHaveBeenLastCalledWith(
      expect.objectContaining({
        max: 2,
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
    await readiness.onApplicationShutdown();
    expect(pool.end).toHaveBeenCalledOnce();
    expect(pool.on).toHaveBeenCalledWith('error', expect.any(Function));
  });
});
