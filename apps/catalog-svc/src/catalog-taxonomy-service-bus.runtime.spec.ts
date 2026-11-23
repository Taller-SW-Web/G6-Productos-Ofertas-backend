import type { CatalogMessageService } from './catalog-message.service.js';
import type { Database } from './database.js';
import {
  createCatalogServiceBus,
  taxonomyReplyQueue,
  taxonomyRequestQueue,
  type CatalogServiceBus,
} from './catalog-service-bus.js';
import { relayCatalogDelivery } from './catalog-service-bus-relay.js';
import { CatalogTaxonomyServiceBusRuntime } from './catalog-taxonomy-service-bus.runtime.js';

vi.mock('./catalog-service-bus.js', async (original) => ({
  ...(await original<typeof import('./catalog-service-bus.js')>()),
  createCatalogServiceBus: vi.fn(),
}));
vi.mock('./catalog-service-bus-relay.js', () => ({
  relayCatalogDelivery: vi.fn(),
}));

describe('Catalog H5 transport readiness', () => {
  let runtime: CatalogTaxonomyServiceBusRuntime | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv('MESSAGING_PROVIDER', 'AZURE_SERVICE_BUS');
    vi.stubEnv('CATALOG_H5_DESTINATIONS', taxonomyReplyQueue);
  });

  afterEach(async () => {
    await runtime?.onModuleDestroy();
    runtime = undefined;
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.resetAllMocks();
  });

  function fixture() {
    const storage = vi.fn().mockResolvedValue({ rows: [{ ready: true }] });
    const probe = vi.fn().mockResolvedValue([]);
    const close = vi.fn().mockResolvedValue(undefined);
    const verifySender = vi.fn().mockResolvedValue(undefined);
    const closeBus = vi.fn().mockResolvedValue(undefined);
    let reportError: (() => void) | undefined;
    const subscribeWithProbe = vi.fn(
      (_queue: string, _consumer: unknown, onError: () => void) => {
        reportError = onError;
        return { probe, close };
      },
    );
    vi.mocked(createCatalogServiceBus).mockReturnValue({
      subscribeWithProbe,
      verifySender,
      close: closeBus,
    } as unknown as CatalogServiceBus);
    vi.mocked(relayCatalogDelivery).mockResolvedValue('EMPTY');
    const database = {
      read: (work: (db: { execute: typeof storage }) => unknown) =>
        work({ execute: storage }),
    } as unknown as Database;
    runtime = new CatalogTaxonomyServiceBusRuntime(database, {
      consume: vi.fn(),
    } as unknown as CatalogMessageService);
    return {
      runtime,
      storage,
      probe,
      verifySender,
      subscribeWithProbe,
      failReceiver: () => reportError?.(),
    };
  }

  it('detects storage and idle broker loss, rejects a stale success, and becomes ready without restart', async () => {
    const f = fixture();
    await f.runtime.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.runtime.ready).toBe(true);
    expect(f.subscribeWithProbe).toHaveBeenCalledWith(
      taxonomyRequestQueue,
      expect.anything(),
      expect.any(Function),
    );

    f.probe.mockRejectedValueOnce(new Error('receiver offline'));
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.runtime.ready).toBe(false);
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.runtime.ready).toBe(true);

    f.verifySender.mockRejectedValueOnce(new Error('sender offline'));
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.runtime.ready).toBe(false);
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.runtime.ready).toBe(true);

    f.storage.mockResolvedValueOnce({ rows: [{ ready: false }] });
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.runtime.ready).toBe(false);
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.runtime.ready).toBe(true);

    f.probe.mockImplementationOnce(async () => f.failReceiver());
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.runtime.ready).toBe(false);
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.runtime.ready).toBe(true);
    expect(f.subscribeWithProbe).toHaveBeenCalledTimes(1);
  });

  it('refuses to start the consumer without the migration and runtime privileges', async () => {
    const f = fixture();
    f.storage.mockResolvedValue({ rows: [{ ready: false }] });
    await expect(f.runtime.onApplicationBootstrap()).rejects.toThrow(
      'CATALOG_H5_TAXONOMY_STORAGE_NOT_READY',
    );
    expect(f.runtime.ready).toBe(false);
    expect(f.subscribeWithProbe).not.toHaveBeenCalled();
  });
});
