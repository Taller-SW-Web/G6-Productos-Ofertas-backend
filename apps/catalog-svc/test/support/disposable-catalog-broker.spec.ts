import { describe, expect, it, vi } from 'vitest';
import { DisposableCatalogBroker } from './disposable-catalog-broker.js';

describe('DisposableCatalogBroker regression safeguards', () => {
  it('cleans up container and propagates detailed error when start fails mid-initialization', async () => {
    const broker = new DisposableCatalogBroker();
    const closeSpy = vi.spyOn(broker, 'close').mockResolvedValue(undefined);
    vi.spyOn(broker, 'command').mockImplementation((args) => {
      if (args[0] === 'run') return 'container-id';
      throw new Error(
        'Disposable joint broker command failed (docker port): simulated daemon timeout',
      );
    });

    await expect(broker.start()).rejects.toThrow(/simulated daemon timeout/);
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });
});
