import { ServiceBusClient } from '@azure/service-bus';
import { TaxonomyServiceBusRuntime } from './taxonomy-service-bus.runtime.js';
import {
  catalogTaxonomyQueue,
  taxonomyCatalogQueue,
} from '../config/service-bus.js';

vi.mock('@azure/service-bus', () => ({ ServiceBusClient: vi.fn() }));

describe('Taxonomy H5 transport readiness', () => {
  let runtime: TaxonomyServiceBusRuntime | undefined;

  beforeEach(() => vi.useFakeTimers());
  afterEach(async () => {
    await runtime?.close();
    runtime = undefined;
    vi.useRealTimers();
    vi.resetAllMocks();
  });

  it('checks storage and both links while idle and recovers in the same process', async () => {
    const namespace = 'g6-taxonomy-local.servicebus.windows.net';
    const verifyServiceBusStorage = vi.fn().mockResolvedValue(undefined);
    const claimServiceBusDelivery = vi.fn().mockResolvedValue(undefined);
    const peekMessages = vi.fn().mockResolvedValue([]);
    const createMessageBatch = vi.fn().mockResolvedValue({});
    const close = vi.fn().mockResolvedValue(undefined);
    const subscribe = vi.fn(
      (_handlers: { processError: () => Promise<void> }) => ({ close }),
    );
    const createReceiver = vi
      .fn()
      .mockReturnValue({ peekMessages, subscribe, close });
    const createSender = vi.fn().mockReturnValue({ createMessageBatch, close });
    vi.mocked(ServiceBusClient).mockImplementation(function () {
      return {
        createReceiver,
        createSender,
        close,
      } as unknown as ServiceBusClient;
    });
    runtime = new TaxonomyServiceBusRuntime(
      {
        namespace,
        enabled: true,
        clientId: '12345678-abcd-4321-9876-abcdef123456',
      },
      {
        verifyServiceBusStorage,
        claimServiceBusDelivery,
        finishServiceBusDelivery: vi.fn(),
        consumir: vi.fn(),
      },
    );
    runtime.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(runtime.available).toBe(true);
    expect(createReceiver).toHaveBeenCalledWith(
      catalogTaxonomyQueue,
      expect.anything(),
    );
    expect(createSender).toHaveBeenCalledWith(taxonomyCatalogQueue);

    verifyServiceBusStorage.mockRejectedValueOnce(new Error('storage offline'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(runtime.available).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(runtime.available).toBe(true);

    createMessageBatch.mockRejectedValueOnce(new Error('sender offline'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(runtime.available).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(runtime.available).toBe(true);

    peekMessages.mockImplementationOnce(async () => {
      await subscribe.mock.calls[0][0].processError();
      return [];
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(runtime.available).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(runtime.available).toBe(true);
    expect(subscribe).toHaveBeenCalledTimes(1);
  });
});
