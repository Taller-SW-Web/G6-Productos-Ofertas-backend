import {
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from '@azure/identity';
import {
  ServiceBusClient,
  type ProcessErrorArgs,
  type ServiceBusReceivedMessage,
  type ServiceBusReceiver,
} from '@azure/service-bus';

export const combosServiceBusRoutes = {
  'g6.combos.from.catalog': [
    'catalog.product.deactivated',
    'catalog.sku.deactivated',
  ],
  'g6.combos.from.inventory': ['inventory.stock.changed'],
} as const;

export type CombosEventQueue = keyof typeof combosServiceBusRoutes;

export type CombosServiceBusConfig =
  | {
      readonly provider: 'AZURE_SERVICE_BUS';
      readonly enabled: false;
    }
  | {
      readonly provider: 'AZURE_SERVICE_BUS';
      readonly enabled: true;
      readonly namespace: string;
      readonly clientId: string | undefined;
    };

const NAMESPACE_REGEX =
  /^[a-z][a-z0-9-]{4,48}[a-z0-9]\.servicebus\.windows\.net$/;
const UUID_REGEX =
  /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const ZERO_UUID_REGEX = /^0{8}-0{4}-0{4}-0{4}-0{12}$/;

export function readCombosServiceBus(
  env: NodeJS.ProcessEnv,
): CombosServiceBusConfig | undefined {
  const provider = env.MESSAGING_PROVIDER;
  const namespace = env.SERVICE_BUS_NAMESPACE_FQDN?.trim();
  const clientId = env.AZURE_CLIENT_ID?.trim() || undefined;
  const enabled = env.COMBOS_SERVICE_BUS_EVENTS_ENABLED;

  if (provider === undefined || provider === 'RABBITMQ') {
    if (enabled === 'true') {
      throw new Error('COMBOS_SERVICE_BUS_CONFIGURATION_INVALID');
    }
    if (enabled !== undefined && enabled !== 'false') {
      throw new Error('COMBOS_SERVICE_BUS_CONFIGURATION_INVALID');
    }
    return undefined;
  }

  if (provider !== 'AZURE_SERVICE_BUS') {
    throw new Error('COMBOS_SERVICE_BUS_CONFIGURATION_INVALID');
  }

  if (
    env.COMBOS_AMQP_ENABLED === 'true' ||
    (env.COMBOS_AMQP_URL !== undefined && env.COMBOS_AMQP_URL.trim() !== '')
  ) {
    throw new Error('COMBOS_SERVICE_BUS_CONFIGURATION_INVALID');
  }

  if (enabled === undefined || enabled === 'false') {
    return { provider: 'AZURE_SERVICE_BUS', enabled: false };
  }

  if (enabled !== 'true') {
    throw new Error('COMBOS_SERVICE_BUS_CONFIGURATION_INVALID');
  }

  if (
    !namespace ||
    !NAMESPACE_REGEX.test(namespace) ||
    (clientId !== undefined &&
      (!UUID_REGEX.test(clientId) || ZERO_UUID_REGEX.test(clientId))) ||
    (env.NODE_ENV === 'production' &&
      (env.G6_SERVICE_BUS_PRODUCTION_ENABLED !== 'true' ||
        env.G6_SECURITY_MODE !== 'G7_AUTHENTICATED' ||
        !clientId))
  ) {
    throw new Error('COMBOS_SERVICE_BUS_CONFIGURATION_INVALID');
  }

  return {
    provider: 'AZURE_SERVICE_BUS',
    enabled: true,
    namespace,
    clientId,
  };
}

export type CombosServiceBusEnabledConfig = Extract<
  CombosServiceBusConfig,
  { enabled: true }
>;

export interface QueueRuntimeState {
  queue: CombosEventQueue;
  ready: boolean;
  subscribed: boolean;
  lastErrorCode: string | null;
  lastCheckedAt: string | null;
}

export type ServiceBusClientLike = Pick<
  ServiceBusClient,
  'createReceiver' | 'close'
>;

type DeliveryHandler = (
  queue: CombosEventQueue,
  receiver: Pick<
    ServiceBusReceiver,
    'completeMessage' | 'abandonMessage' | 'deadLetterMessage'
  >,
  message: ServiceBusReceivedMessage,
) => Promise<void>;

export interface CombosServiceBusHooks {
  onConnectionError?: (
    queue: CombosEventQueue,
    code: string,
    errorSource?: string,
  ) => void;
  onLog?: (
    level: 'log' | 'warn' | 'error',
    payload: Record<string, unknown>,
  ) => void;
  clientFactory?: (config: CombosServiceBusEnabledConfig) => ServiceBusClientLike;
  probeIntervalMs?: number;
}

function safeSdkErrorCode(error: unknown): string {
  if (typeof error !== 'object' || error === null) return 'UNKNOWN';
  if ('code' in error && typeof error.code === 'string' && error.code.trim()) {
    return error.code.slice(0, 64).replace(/[^A-Za-z0-9_.-]/g, '_');
  }
  if ('name' in error && typeof error.name === 'string' && error.name.trim()) {
    return error.name.slice(0, 64).replace(/[^A-Za-z0-9_.-]/g, '_');
  }
  return 'UNKNOWN';
}

export class CombosServiceBus {
  private readonly client: ServiceBusClientLike;
  private readonly receivers = new Map<CombosEventQueue, ServiceBusReceiver>();
  private readonly subscriptions = new Map<
    CombosEventQueue,
    { close(): Promise<void> }
  >();
  private readonly states = new Map<CombosEventQueue, QueueRuntimeState>();
  private readonly active = new Set<Promise<void>>();
  private readonly probeIntervalMs: number;
  private timer?: ReturnType<typeof setTimeout>;
  private probe?: Promise<void>;
  private started = false;
  private starting = false;
  private stopped = false;
  private closingPromise?: Promise<void>;

  constructor(
    private readonly config: CombosServiceBusEnabledConfig,
    private readonly handle: DeliveryHandler,
    private readonly hooks: CombosServiceBusHooks = {},
  ) {
    this.probeIntervalMs = hooks.probeIntervalMs ?? 5000;
    for (const queue of Object.keys(
      combosServiceBusRoutes,
    ) as CombosEventQueue[]) {
      this.states.set(queue, {
        queue,
        ready: false,
        subscribed: false,
        lastErrorCode: null,
        lastCheckedAt: null,
      });
    }
    this.client = hooks.clientFactory
      ? hooks.clientFactory(config)
      : new ServiceBusClient(
          config.namespace,
          config.clientId
            ? new ManagedIdentityCredential({ clientId: config.clientId })
            : new DefaultAzureCredential(),
          {
            retryOptions: {
              maxRetries: 3,
              retryDelayInMs: 500,
              maxRetryDelayInMs: 5000,
            },
          },
        );
  }

  get available(): boolean {
    if (this.stopped || !this.started) return false;
    for (const state of this.states.values()) {
      if (!state.ready || !state.subscribed) return false;
    }
    return this.states.size === 2;
  }

  getQueueStates(): Record<CombosEventQueue, QueueRuntimeState> {
    return {
      'g6.combos.from.catalog': {
        ...this.states.get('g6.combos.from.catalog')!,
      },
      'g6.combos.from.inventory': {
        ...this.states.get('g6.combos.from.inventory')!,
      },
    };
  }

  async start(): Promise<void> {
    if (this.stopped) throw new Error('COMBOS_SERVICE_BUS_ALREADY_STOPPED');
    if (this.started || this.starting) return;
    this.starting = true;
    const queues = Object.keys(combosServiceBusRoutes) as CombosEventQueue[];
    try {
      for (const queue of queues) {
        this.createQueueReceiver(queue);
      }
      const linkResults = await this.checkAllLinks(5000);
      if (!linkResults.every(Boolean)) {
        throw new Error('COMBOS_SERVICE_BUS_LINK_UNAVAILABLE');
      }
      for (const queue of queues) {
        this.subscribeQueue(queue);
      }
      this.started = true;
      this.hooks.onLog?.('log', {
        event: 'service_bus_started',
        queues,
        identity_mode: this.config.clientId
          ? 'managed_identity'
          : 'default_azure_credential',
      });
      this.scheduleProbe();
    } catch (error) {
      await this.close();
      throw error instanceof Error &&
        error.message === 'COMBOS_SERVICE_BUS_LINK_UNAVAILABLE'
        ? error
        : new Error('COMBOS_SERVICE_BUS_START_FAILED');
    } finally {
      this.starting = false;
    }
  }

  private createQueueReceiver(queue: CombosEventQueue): ServiceBusReceiver {
    const receiver = this.client.createReceiver(queue, {
      receiveMode: 'peekLock',
      skipParsingBodyAsJson: true,
      maxAutoLockRenewalDurationInMs: 60_000,
    });
    this.receivers.set(queue, receiver);
    return receiver;
  }

  private subscribeQueue(queue: CombosEventQueue): void {
    const receiver = this.receivers.get(queue);
    if (!receiver || this.subscriptions.has(queue)) return;
    const subscription = receiver.subscribe(
      {
        processMessage: async (message) => {
          if (this.stopped) return;
          const task = this.handle(queue, receiver, message).catch((error) => {
            const code = safeSdkErrorCode(error);
            const state = this.states.get(queue);
            if (state) {
              state.ready = false;
              state.lastErrorCode = code;
            }
            this.hooks.onLog?.('error', {
              event: 'service_bus_delivery_error',
              queue,
              code,
            });
            throw error;
          });
          this.active.add(task);
          try {
            await task;
          } finally {
            this.active.delete(task);
          }
        },
        processError: async (args: ProcessErrorArgs) => {
          const code = safeSdkErrorCode(args.error);
          const state = this.states.get(queue);
          if (state) {
            state.ready = false;
            state.lastErrorCode = code;
          }
          this.hooks.onConnectionError?.(queue, code, args.errorSource);
          this.hooks.onLog?.('warn', {
            event: 'service_bus_receiver_error',
            queue,
            error_source: args.errorSource,
            code,
          });
        },
      },
      { autoCompleteMessages: false, maxConcurrentCalls: 1 },
    );
    this.subscriptions.set(queue, subscription);
    const state = this.states.get(queue);
    if (state) {
      state.subscribed = true;
      state.ready = true;
      state.lastErrorCode = null;
    }
  }

  private async checkQueueLink(
    queue: CombosEventQueue,
    timeoutMs: number,
  ): Promise<boolean> {
    const state = this.states.get(queue)!;
    const receiver = this.receivers.get(queue);
    if (!receiver || receiver.isClosed) {
      state.ready = false;
      state.subscribed = false;
      state.lastCheckedAt = new Date().toISOString();
      state.lastErrorCode = 'RECEIVER_CLOSED';
      return false;
    }
    try {
      await receiver.peekMessages(1, {
        abortSignal: AbortSignal.timeout(timeoutMs),
      });
      state.ready = !this.stopped && state.subscribed;
      state.lastErrorCode = null;
      state.lastCheckedAt = new Date().toISOString();
      return state.ready;
    } catch (error) {
      const code = safeSdkErrorCode(error);
      state.ready = false;
      state.lastErrorCode = code;
      state.lastCheckedAt = new Date().toISOString();
      this.hooks.onConnectionError?.(queue, code, 'peek_probe');
      return false;
    }
  }

  private async checkAllLinks(timeoutMs: number): Promise<boolean[]> {
    const queues = Object.keys(combosServiceBusRoutes) as CombosEventQueue[];
    return Promise.all(
      queues.map((queue) => this.checkQueueLink(queue, timeoutMs)),
    );
  }

  private async recoverQueueIfNeeded(queue: CombosEventQueue): Promise<void> {
    if (this.stopped) return;
    const receiver = this.receivers.get(queue);
    if (receiver && !receiver.isClosed && this.subscriptions.has(queue)) {
      return;
    }
    const oldSub = this.subscriptions.get(queue);
    this.subscriptions.delete(queue);
    if (oldSub) await oldSub.close().catch(() => undefined);
    if (receiver && !receiver.isClosed) {
      await receiver.close().catch(() => undefined);
    }
    this.receivers.delete(queue);
    if (this.stopped) return;
    try {
      this.createQueueReceiver(queue);
      const ok = await this.checkQueueLink(queue, 3000);
      if (ok && !this.stopped) {
        this.subscribeQueue(queue);
        this.hooks.onLog?.('log', {
          event: 'service_bus_receiver_recovered',
          queue,
        });
      }
    } catch (error) {
      const code = safeSdkErrorCode(error);
      const state = this.states.get(queue);
      if (state) {
        state.ready = false;
        state.subscribed = false;
        state.lastErrorCode = code;
      }
      this.hooks.onConnectionError?.(queue, code, 'recovery');
    }
  }

  private scheduleProbe(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      if (this.stopped) return;
      this.probe = (async () => {
        const queues = Object.keys(
          combosServiceBusRoutes,
        ) as CombosEventQueue[];
        for (const queue of queues) {
          if (this.stopped) break;
          await this.recoverQueueIfNeeded(queue);
          if (!this.stopped) {
            await this.checkQueueLink(queue, 2000);
          }
        }
      })().finally(() => {
        if (!this.stopped) this.scheduleProbe();
      });
    }, this.probeIntervalMs);
    this.timer.unref();
  }

  async close(): Promise<void> {
    if (this.closingPromise) return this.closingPromise;
    this.closingPromise = (async () => {
      this.stopped = true;
      clearTimeout(this.timer);
      for (const state of this.states.values()) {
        state.ready = false;
        state.subscribed = false;
      }
      await Promise.allSettled(
        [...this.subscriptions.values()].map((subscription) =>
          subscription.close(),
        ),
      );
      this.subscriptions.clear();
      await Promise.allSettled(this.active);
      await this.probe?.catch(() => undefined);
      await Promise.allSettled(
        [...this.receivers.values()].map((receiver) => receiver.close()),
      );
      this.receivers.clear();
      await this.client.close().catch(() => undefined);
    })();
    return this.closingPromise;
  }
}
