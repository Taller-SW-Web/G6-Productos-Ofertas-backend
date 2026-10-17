import { ReadinessController, UnconfiguredDatabase } from './readiness.js';

describe('readiness boundary', () => {
  afterEach(() => vi.useRealTimers());

  it('fails closed without a persistence adapter', async () => {
    await expect(
      new ReadinessController(new UnconfiguredDatabase()).ready(),
    ).rejects.toMatchObject({ status: 503 });
  });

  it('requires a successful dependency check', async () => {
    const check = vi.fn().mockResolvedValue(undefined);
    await expect(new ReadinessController({ check }).ready()).resolves.toEqual({
      status: 'ready',
      service: 'catalog-svc',
    });
    expect(check).toHaveBeenCalledOnce();
  });

  it('suppresses dependency errors and credentials', async () => {
    const controller = new ReadinessController({
      check: async () => {
        throw new Error('postgres://user:private-secret@host/db');
      },
    });
    try {
      await controller.ready();
      expect.unreachable();
    } catch (error) {
      expect(JSON.stringify(error)).not.toContain('private-secret');
      expect(error).toMatchObject({ status: 503 });
    }
  });

  it('bounds a stalled dependency check', async () => {
    vi.useFakeTimers();
    const result = new ReadinessController({
      check: () => new Promise(() => {}),
    }).ready();
    const assertion = expect(result).rejects.toMatchObject({ status: 503 });
    await vi.advanceTimersByTimeAsync(2000);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });
});
