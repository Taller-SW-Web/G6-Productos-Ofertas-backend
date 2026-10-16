import { PromotionsSvcService } from '../promotions-svc.service.js';
import { PromotionsReadinessService } from './promotions-readiness.service.js';

describe('Promotions readiness', () => {
  afterEach(() => vi.useRealTimers());

  it('does not confuse live process with implemented dependencies', async () => {
    expect(new PromotionsSvcService().getHealth().status).toBe('ok');
    expect(await new PromotionsReadinessService({}).check()).toEqual({
      status: 'not_ready',
      service: 'promotions-svc',
      dependencies: { database: 'not_implemented', broker: 'not_implemented' },
    });
  });

  it('requires both own dependencies to pass on every check', async () => {
    const database = { check: vi.fn().mockResolvedValue(undefined) };
    const broker = { check: vi.fn().mockResolvedValue(undefined) };
    const service = new PromotionsReadinessService({ database, broker });
    expect((await service.check()).status).toBe('ready');
    database.check.mockRejectedValueOnce(new Error('database unavailable'));
    expect(await service.check()).toMatchObject({
      status: 'not_ready',
      dependencies: { database: 'down', broker: 'up' },
    });
    expect((await service.check()).status).toBe('ready');
    expect(broker.check).toHaveBeenCalledTimes(3);
  });

  it('bounds a hanging probe and does not leak its errors', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const service = new PromotionsReadinessService({
      database: {
        check: (value) => {
          signal = value;
          return new Promise<void>(() => undefined);
        },
      },
      broker: {
        check: () => Promise.reject(new Error('amqp://user:secret@host')),
      },
    });
    const result = service.check();
    await vi.advanceTimersByTimeAsync(1000);
    expect(await result).toMatchObject({
      status: 'not_ready',
      dependencies: { database: 'down', broker: 'down' },
    });
    expect(signal?.aborted).toBe(true);
    expect(JSON.stringify(await result)).not.toContain('secret');
    expect(vi.getTimerCount()).toBe(0);
  });
});
