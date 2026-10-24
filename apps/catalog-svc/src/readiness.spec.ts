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

  it('shares concurrent checks and never reuses an earlier success', async () => {
    let finish!: () => void;
    const check = vi.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const controller = new ReadinessController({ check });
    const probes = Array.from({ length: 100 }, () => controller.ready());
    await Promise.resolve();
    expect(check).toHaveBeenCalledOnce();
    finish();
    await Promise.all(probes);
    check.mockRejectedValue(new Error('dependency down'));
    await expect(controller.ready()).rejects.toMatchObject({ status: 503 });
    expect(check).toHaveBeenCalledTimes(2);
  });

  it('stays closed after timeout without queuing more slow PostgreSQL checks', async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const check = vi.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const controller = new ReadinessController({ check });
    const probes = Array.from({ length: 100 }, () =>
      expect(controller.ready()).rejects.toMatchObject({ status: 503 }),
    );
    await vi.advanceTimersByTimeAsync(2000);
    await Promise.all(probes);
    for (let i = 0; i < 100; i++) {
      await expect(controller.ready()).rejects.toMatchObject({ status: 503 });
    }
    expect(check).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    check.mockRejectedValue(new Error('still down'));
    await expect(controller.ready()).rejects.toMatchObject({ status: 503 });
    expect(check).toHaveBeenCalledTimes(2);
  });
});
