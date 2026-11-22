import { CouponH5Runtime } from './coupon-h5-runtime.js';
import type { EventReceiver } from './service-bus-events.js';
import type { CouponH5Worker } from './coupon-h5-operations.js';

const config = {
  namespace: 'g6-test-events.servicebus.windows.net',
  eventsEnabled: false,
  couponCommandsEnabled: true,
};

function fixture(
  worker: Pick<CouponH5Worker, 'process'> | undefined,
  pauseAdmission = false,
) {
  let handlers: Parameters<EventReceiver['subscribe']>[0] | undefined;
  const subscription = { close: vi.fn(async () => undefined) };
  const sender = {
    createMessageBatch: vi.fn(),
    sendMessages: vi.fn(),
    close: vi.fn(async () => undefined),
  };
  const receiver: EventReceiver = {
    peekMessages: vi.fn(async () => []),
    subscribe: vi.fn((value) => {
      handlers = value;
      return subscription;
    }),
    completeMessage: vi.fn(),
    abandonMessage: vi.fn(),
    deadLetterMessage: vi.fn(),
    close: vi.fn(async () => undefined),
  };
  const open = vi.fn(() => ({
    sender,
    receiver,
    close: vi.fn(async () => undefined),
  }));
  const store = { assertAvailable: vi.fn(), claim: vi.fn(), finish: vi.fn() };
  return {
    runtime: new CouponH5Runtime(
      { ...config, couponAdmissionPaused: pauseAdmission },
      store,
      worker,
      open,
    ),
    store,
    open,
    receiver,
    subscription,
    handlers: () => handlers,
  };
}

describe('Durable H5 coupon runtime', () => {
  it('does not open the transport if no authoritative worker is configured', async () => {
    const { runtime, store, open } = fixture(undefined);
    runtime.onApplicationBootstrap();
    expect(runtime.enabled).toBe(true);
    expect(() => runtime.assertAdmissionAvailable()).toThrow(
      'COUPON_H5_RUNTIME_UNAVAILABLE',
    );
    expect(store.claim).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    await runtime.onModuleDestroy();
  });

  it('pumps without requests and keeps SQL admission available after a transport loss', async () => {
    const { runtime, store, receiver, subscription, handlers } = fixture({
      process: vi.fn(),
    });
    try {
      runtime.onApplicationBootstrap();
      await vi.waitFor(() => runtime.assertAdmissionAvailable());
      expect(store.claim).toHaveBeenCalled();
      expect(receiver.subscribe).toHaveBeenCalledWith(expect.anything(), {
        autoCompleteMessages: false,
        maxConcurrentCalls: 1,
      });
      await handlers()?.processError(
        {} as Parameters<
          NonNullable<ReturnType<typeof handlers>>['processError']
        >[0],
      );
      expect(() => runtime.assertAvailable()).toThrow(
        'COUPON_H5_RUNTIME_UNAVAILABLE',
      );
      expect(() => runtime.assertAdmissionAvailable()).not.toThrow();
    } finally {
      await runtime.onModuleDestroy();
    }
    expect(subscription.close).toHaveBeenCalledOnce();
    expect(receiver.close).toHaveBeenCalledOnce();
    expect(() => runtime.assertAdmissionAvailable()).toThrow(
      'COUPON_H5_RUNTIME_UNAVAILABLE',
    );
  });

  it('drains previously admitted commands while new admissions are paused', async () => {
    const { runtime, store } = fixture({ process: vi.fn() }, true);
    try {
      runtime.onApplicationBootstrap();
      await vi.waitFor(() => runtime.assertAvailable());
      expect(store.claim).toHaveBeenCalled();
      expect(runtime.enabled).toBe(true);
      expect(() => runtime.assertAdmissionAvailable()).toThrow(
        'COUPON_H5_RUNTIME_UNAVAILABLE',
      );
    } finally {
      await runtime.onModuleDestroy();
    }
  });
});
