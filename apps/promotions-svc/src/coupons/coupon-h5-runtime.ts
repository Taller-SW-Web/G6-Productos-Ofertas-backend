import {
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from '@azure/identity';
import { ServiceBusClient, type ServiceBusSender } from '@azure/service-bus';
import {
  CouponH5DeliveryHandler,
  CouponH5Relay,
  type CouponH5DeliveryStore,
} from './coupon-h5-delivery.js';
import { couponH5Queue, type CouponH5Worker } from './coupon-h5-operations.js';
import type { PromotionsServiceBusConfig } from './service-bus-config.js';
import type { EventReceiver } from './service-bus-events.js';

interface CouponBus {
  sender: Pick<
    ServiceBusSender,
    'createMessageBatch' | 'sendMessages' | 'close'
  >;
  receiver: EventReceiver;
  close(): Promise<void>;
}

export function isolatedCouponH5Bus(): CouponBus {
  let handlers: Parameters<EventReceiver['subscribe']>[0] | undefined;
  let closed = false;
  return {
    sender: {
      createMessageBatch: async () => {
        const items: unknown[] = [];
        return {
          tryAddMessage: (msg: unknown) => {
            items.push(msg);
            return true;
          },
          get count() {
            return items.length;
          },
          get sizeInBytes() {
            return JSON.stringify(items).length;
          },
          get maxSizeInBytes() {
            return 256 * 1024;
          },
          _messages: items,
        } as never;
      },
      sendMessages: async (batch: unknown) => {
        if (closed || !handlers) return;
        const list =
          batch &&
          typeof batch === 'object' &&
          '_messages' in batch &&
          Array.isArray((batch as { _messages: unknown[] })._messages)
            ? (batch as { _messages: unknown[] })._messages
            : Array.isArray(batch)
              ? batch
              : [batch];
        for (const msg of list) {
          await handlers.processMessage(msg as never);
        }
      },
      close: async () => {
        closed = true;
      },
    },
    receiver: {
      subscribe: (nextHandlers) => {
        handlers = nextHandlers;
        return {
          close: async () => {
            handlers = undefined;
          },
        };
      },
      completeMessage: async () => undefined,
      abandonMessage: async () => undefined,
      deadLetterMessage: async () => undefined,
      peekMessages: async () => [],
      close: async () => {
        handlers = undefined;
      },
    },
    close: async () => {
      closed = true;
      handlers = undefined;
    },
  };
}

export function nativeCouponH5Bus(
  config: PromotionsServiceBusConfig,
): CouponBus {
  if (
    process.env.NODE_ENV === 'test' &&
    process.env.PROMOTIONS_H5_ISOLATED_BUS === '1'
  ) {
    return isolatedCouponH5Bus();
  }
  const identity = config.managedIdentityClientId
    ? new ManagedIdentityCredential({
        clientId: config.managedIdentityClientId,
      })
    : new DefaultAzureCredential();
  const client = new ServiceBusClient(config.namespace, identity);
  return {
    sender: client.createSender(couponH5Queue),
    receiver: client.createReceiver(couponH5Queue, {
      receiveMode: 'peekLock',
      skipParsingBodyAsJson: true,
      maxAutoLockRenewalDurationInMs: 60_000,
    }),
    close: () => client.close(),
  };
}

export class CouponH5Runtime {
  private bus?: CouponBus;
  private subscription?: { close(): Promise<void> };
  private relay?: CouponH5Relay;
  private timer?: ReturnType<typeof setTimeout>;
  private tick?: Promise<void>;
  private readonly inFlight = new Set<Promise<void>>();
  private stopping = false;
  private available = false;
  private started = false;

  constructor(
    private readonly config: PromotionsServiceBusConfig | undefined,
    private readonly store: Pick<
      CouponH5DeliveryStore,
      'assertAvailable' | 'claim' | 'finish'
    >,
    private readonly worker: Pick<CouponH5Worker, 'process'> | undefined,
    private readonly open = nativeCouponH5Bus,
  ) {}

  get enabled(): boolean {
    return this.config?.couponCommandsEnabled === true;
  }

  assertAvailable(): void {
    if (!this.available || this.stopping)
      throw new Error('COUPON_H5_RUNTIME_UNAVAILABLE');
  }

  assertAdmissionAvailable(): void {
    if (!this.started || this.stopping || this.config?.couponAdmissionPaused)
      throw new Error('COUPON_H5_RUNTIME_UNAVAILABLE');
  }

  onApplicationBootstrap(): void {
    if (!this.enabled || !this.worker || this.tick || this.stopping) return;
    this.tick = this.poll();
  }

  private async poll(): Promise<void> {
    if (this.stopping) return;
    let delay = 5000;
    try {
      if (!this.available) {
        await this.store.assertAvailable();
        if (this.stopping) return;
        const bus = (this.bus ??= this.open(this.config!));
        await Promise.all([
          bus.sender.createMessageBatch({
            abortSignal: AbortSignal.timeout(5000),
          }),
          bus.receiver.peekMessages(1, {
            abortSignal: AbortSignal.timeout(5000),
          }),
        ]);
        if (this.stopping) return;
        if (!this.subscription) {
          const handler = new CouponH5DeliveryHandler(
            couponH5Queue,
            this.worker!,
            bus.receiver,
          );
          this.subscription = bus.receiver.subscribe(
            {
              processMessage: (message) => {
                const task = handler.handle(message);
                this.inFlight.add(task);
                return task.finally(() => {
                  this.inFlight.delete(task);
                });
              },
              processError: async () => {
                this.available = false;
              },
            },
            { autoCompleteMessages: false, maxConcurrentCalls: 1 },
          );
          this.relay = new CouponH5Relay(this.store, bus.sender);
        }
        this.available = true;
        this.started = true;
      }
      const result = await this.relay!.publishOne();
      if (result === 'pending') this.available = false;
      else delay = result === 'empty' ? 1000 : 200;
    } catch {
      this.available = false;
    } finally {
      if (!this.stopping) {
        this.timer = setTimeout(() => {
          this.tick = this.poll();
        }, delay);
        this.timer.unref();
      }
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    this.available = false;
    clearTimeout(this.timer);
    await this.tick;
    await this.subscription?.close().catch(() => undefined);
    await Promise.allSettled(this.inFlight);
    if (this.bus) {
      await Promise.allSettled([
        this.bus.receiver.close(),
        this.bus.sender.close(),
      ]);
      await this.bus.close();
    }
  }
}
