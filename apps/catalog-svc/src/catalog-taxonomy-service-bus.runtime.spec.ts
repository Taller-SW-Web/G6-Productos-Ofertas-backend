import type { CatalogMessageService } from './catalog-message.service.js';
import type { Database } from './database.js';
import {
  bulkRequestQueue,
  catalogIncomingQueues,
  createCatalogServiceBus,
  taxonomyReplyQueue,
  taxonomyRequestQueue,
  type CatalogServiceBus,
} from './catalog-service-bus.js';
import { relayCatalogDelivery } from './catalog-service-bus-relay.js';
import { CatalogTaxonomyServiceBusRuntime } from './catalog-taxonomy-service-bus.runtime.js';
import { createCatalogBulkConsumer } from './catalog-service-bus.runtime.js';

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

  function fixture(destinations = taxonomyReplyQueue) {
    vi.stubEnv('CATALOG_H5_DESTINATIONS', destinations);
    const storage = vi.fn().mockResolvedValue({ rows: [{ ready: true }] });
    const probe = vi.fn().mockResolvedValue([]);
    const close = vi.fn().mockResolvedValue(undefined);
    const verifySender = vi.fn().mockResolvedValue(undefined);
    const closeBus = vi.fn().mockResolvedValue(undefined);
    let reportError: (() => void) | undefined;
    const consumers = new Map<string, Pick<CatalogMessageService, 'consume'>>();
    const subscribeWithProbe = vi.fn(
      (
        queue: string,
        consumer: Pick<CatalogMessageService, 'consume'>,
        onError: () => void,
      ) => {
        consumers.set(queue, consumer);
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
    const consume = vi.fn().mockResolvedValue('APPLIED');
    runtime = new CatalogTaxonomyServiceBusRuntime(database, {
      consume,
    } as unknown as CatalogMessageService);
    return {
      runtime,
      storage,
      probe,
      verifySender,
      subscribeWithProbe,
      consumers,
      consume,
      failReceiver: () => reportError?.(),
    };
  }

  it('rejects a reply-dependent Taxonomy check but processes other events without the route', async () => {
    const f = fixture('');
    await f.runtime.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(0);
    const taxonomyConsumer = f.consumers.get(taxonomyRequestQueue);
    expect(taxonomyConsumer).toBeDefined();

    const request = {
      name: 'taxonomy.master.deactivation.check.requested',
    } as Parameters<CatalogMessageService['consume']>[0];
    await expect(taxonomyConsumer!.consume(request)).rejects.toThrow(
      'CATALOG_H5_TAXONOMY_REPLY_DISABLED',
    );
    expect(f.consume).not.toHaveBeenCalled();

    const update = {
      name: 'taxonomy.category.updated',
    } as Parameters<CatalogMessageService['consume']>[0];
    await expect(taxonomyConsumer!.consume(update)).resolves.toBe('APPLIED');
    expect(f.consume).toHaveBeenCalledWith(update, false);
  });

  it('consumes a Taxonomy deactivation check with the reply route enabled', async () => {
    const f = fixture(taxonomyReplyQueue);
    await f.runtime.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(0);
    const taxonomyConsumer = f.consumers.get(taxonomyRequestQueue);
    expect(taxonomyConsumer).toBeDefined();

    const request = {
      name: 'taxonomy.master.deactivation.check.requested',
    } as Parameters<CatalogMessageService['consume']>[0];
    await expect(taxonomyConsumer!.consume(request)).resolves.toBe('APPLIED');
    expect(f.consume).toHaveBeenCalledWith(request, true);
  });

  it('rejects Bulk V1/V2/V3 commands before consumption without the result route', async () => {
    const f = fixture('');
    await f.runtime.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(0);
    const bulkConsumer = f.consumers.get(bulkRequestQueue);
    expect(bulkConsumer).toBeDefined();

    for (const schema_version of [1, 2, 3]) {
      const request = {
        name: 'catalog.bulk.upsert.requested',
        schema_version,
      } as Parameters<CatalogMessageService['consume']>[0];
      await expect(bulkConsumer!.consume(request)).rejects.toThrow(
        'CATALOG_H5_BULK_REPLY_DISABLED',
      );
    }
    expect(f.consume).not.toHaveBeenCalled();
  });

  it('consumes a Bulk request normally when the result route is enabled', async () => {
    const f = fixture('g6.bulk.from.catalog');
    await f.runtime.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(0);
    const bulkConsumer = f.consumers.get(bulkRequestQueue);
    expect(bulkConsumer).toBeDefined();

    const request = {
      name: 'catalog.bulk.upsert.requested',
      schema_version: 3,
    } as Parameters<CatalogMessageService['consume']>[0];
    await expect(bulkConsumer!.consume(request)).resolves.toBe('APPLIED');
    expect(f.consume).toHaveBeenCalledWith(request);
  });

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
    expect(f.subscribeWithProbe.mock.calls.map(([queue]) => queue)).toEqual(
      catalogIncomingQueues,
    );

    f.probe.mockRejectedValueOnce(new Error('receiver offline'));
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.runtime.ready).toBe(false);
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

    f.probe.mockImplementationOnce(async () => {
      f.failReceiver();
      return [];
    });
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.runtime.ready).toBe(false);
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.runtime.ready).toBe(false);
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.runtime.ready).toBe(true);
    expect(f.subscribeWithProbe).toHaveBeenCalledTimes(12);
  });

  it('reports unavailable until migration and runtime privileges are present', async () => {
    const f = fixture();
    f.storage.mockResolvedValue({ rows: [{ ready: false }] });
    await expect(f.runtime.onApplicationBootstrap()).resolves.toBeUndefined();
    expect(f.runtime.ready).toBe(false);
    expect(f.subscribeWithProbe).not.toHaveBeenCalled();
    f.storage.mockResolvedValue({ rows: [{ ready: true }] });
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.subscribeWithProbe).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.runtime.ready).toBe(true);
  });

  it('keeps the runtime disabled for the existing H4 provider', async () => {
    vi.stubEnv('MESSAGING_PROVIDER', 'RABBITMQ');
    const f = fixture();
    await f.runtime.onApplicationBootstrap();
    expect(f.runtime.required).toBe(false);
    expect(f.runtime.ready).toBe(true);
    expect(f.subscribeWithProbe).not.toHaveBeenCalled();
  });
});
