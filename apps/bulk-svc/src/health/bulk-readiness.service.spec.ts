import { parseBulkEnvironment } from '../config/bulk-environment.js';
import {
  BulkReadinessService,
  type BulkReadinessPool,
} from './bulk-readiness.service.js';

const configured = parseBulkEnvironment({
  NODE_ENV: 'test',
  BULK_SVC_PORT: '3008',
  DATABASE_URL: 'postgresql://bulk:fixture@127.0.0.1:5432/bulk?sslmode=disable',
});

function serviceWith(query: () => Promise<unknown>) {
  const pool: BulkReadinessPool = {
    query: vi.fn(query),
    end: vi.fn().mockResolvedValue(undefined),
    on: vi.fn().mockReturnThis(),
  };
  return { service: new BulkReadinessService(configured, pool), pool };
}

describe('BulkReadinessService', () => {
  it('executes the read-only schema/table probe and returns true on success', async () => {
    const { service, pool } = serviceWith(async () => undefined);
    await expect(service.check()).resolves.toBe(true);
    expect(pool.query).toHaveBeenCalledWith(
      'SELECT 1 FROM bulk.batch_jobs LIMIT 0',
    );
  });

  it.each([
    'connection refused',
    'query rejected',
    'timeout',
    'missing schema',
  ])('returns false for %s without propagating the error', async (reason) => {
    const { service } = serviceWith(async () => {
      throw new Error(`secret db detail: ${reason}`);
    });
    await expect(service.check()).resolves.toBe(false);
  });

  it('returns false when DATABASE_URL is absent', async () => {
    const config = parseBulkEnvironment({ NODE_ENV: 'test', PORT: '3008' });
    const pool: BulkReadinessPool = {
      query: vi.fn().mockResolvedValue(undefined),
      end: vi.fn().mockResolvedValue(undefined),
      on: vi.fn().mockReturnThis(),
    };
    const service = new BulkReadinessService(config, pool);
    await expect(service.check()).resolves.toBe(false);
    expect(pool.query).not.toHaveBeenCalled();
    await expect(service.onModuleDestroy()).resolves.toBeUndefined();
  });

  it('closes the pool when the Nest module is destroyed', async () => {
    const { service, pool } = serviceWith(async () => undefined);
    await service.onModuleDestroy();
    expect(pool.end).toHaveBeenCalledOnce();
  });
});
