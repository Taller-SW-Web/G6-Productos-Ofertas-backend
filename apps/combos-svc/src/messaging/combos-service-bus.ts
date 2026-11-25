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

export type QueuePhase =
  | 'IDLE'
  | 'LINK_VERIFIED'
  | 'SUBSCRIBED'
  | 'DEGRADED'
  | 'RECOVERING'
  | 'STOPPED';

export interface QueueRuntimeState {
  queue: CombosEventQueue;
  phase: QueuePhase;
  linkReady: boolean;
  subscribed: boolean;
  ready: boolean;
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
  maxBackoffMs?: number;
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
  private readonly recovering = new Map<CombosEventQueue, Promise<void>>();
  private readonly consecutiveFailures = new Map<CombosEventQueue, number>();
  private readonly nextRecoveryAt = new Map<CombosEventQueue, number>();
  private readonly active = new Set<Promise<void>>();
  private readonly probeIntervalMs: number;
  private readonly maxBackoffMs: number;
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
    this.maxBackoffMs = hooks.maxBackoffMs ?? 30_000;
    for (const queue of Object.keys(
      combosServiceBusRoutes,
    ) as CombosEventQueue[]) {
      this.consecutiveFailures.set(queue, 0);
      this.nextRecoveryAt.set(queue, 0);
      this.states.set(queue, {
        queue,
        phase: 'IDLE',
        linkReady: false,
        subscribed: false,
        ready: false,
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

  private recomputeQueueReady(state: QueueRuntimeState): boolean {
    state.ready =
      !this.stopped &&
      this.started &&
      state.phase === 'SUBSCRIBED' &&
      state.linkReady &&
      state.subscribed;
    return state.ready;
  }

  get available(): boolean {
    if (this.stopped || !this.started) return false;
    for (const state of this.states.values()) {
      if (!this.recomputeQueueReady(state)) return false;
    }
    return this.states.size === 2;
  }

  getQueueStates(): Record<CombosEventQueue, QueueRuntimeState> {
    const catalog = this.states.get('g6.combos.from.catalog')!;
    const inventory = this.states.get('g6.combos.from.inventory')!;
    this.recomputeQueueReady(catalog);
    this.recomputeQueueReady(inventory);
    return {
      'g6.combos.from.catalog': { ...catalog },
      'g6.combos.from.inventory': { ...inventory },
    };
  }

  private computeBackoffMs(failures: number): number {
    if (failures <= 0) return 0;
    return Math.min(
      this.maxBackoffMs,
      this.probeIntervalMs * Math.pow(2, Math.min(failures - 1, 6)),
    );
  }

  private recordQueueFailure(queue: CombosEventQueue): void {
    const failures = (this.consecutiveFailures.get(queue) ?? 0) + 1;
    this.consecutiveFailures.set(queue, failures);
    this.nextRecoveryAt.set(queue, Date.now() + this.computeBackoffMs(failures));
  }

  private clearQueueFailure(queue: CombosEventQueue): void {
    this.consecutiveFailures.set(queue, 0);
    this.nextRecoveryAt.set(queue, 0);
  }

  async start(): Promise<void> {
    if (this.stopped) throw new Error('COMBOS_SERVICE_BUS_ALREADY_STOPPED');
    if (this.started || this.starting) return;
    this.starting = true;
    const queues = Object.keys(combosServiceBusRoutes) as CombosEventQueue[];
    try {
      for (const queue of queues) {
        if (this.stopped) break;
        this.createQueueReceiver(queue);
      }
      const linkResults = await Promise.all(
        queues.map((queue) => this.checkQueueLink(queue, 5000)),
      );
      if (this.stopped) {
        throw new Error('COMBOS_SERVICE_BUS_ALREADY_STOPPED');
      }
      for (const [index, queue] of queues.entries()) {
        if (linkResults[index]) {
          this.clearQueueFailure(queue);
          this.subscribeQueue(queue);
        } else {
          await this.teardownQueue(queue);
          this.recordQueueFailure(queue);
          const state = this.states.get(queue)!;
          state.phase = 'DEGRADED';
          state.subscribed = false;
          state.linkReady = false;
          this.recomputeQueueReady(state);
        }
      }
      this.started = true;
      for (const state of this.states.values()) {
        this.recomputeQueueReady(state);
      }
      this.hooks.onLog?.(this.available ? 'log' : 'warn', {
        event: this.available
          ? 'service_bus_started'
          : 'service_bus_started_degraded',
        queues,
        ready: this.available,
        identity_mode: this.config.clientId
          ? 'managed_identity'
          : 'default_azure_credential',
      });
      this.scheduleProbe();
    } catch (error) {
      await this.close();
      throw error instanceof Error &&
        error.message === 'COMBOS_SERVICE_BUS_ALREADY_STOPPED'
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
    if (this.stopped) return;
    const receiver = this.receivers.get(queue);
    if (!receiver || receiver.isClosed || this.subscriptions.has(queue)) return;
    const state = this.states.get(queue)!;
    const subscription = receiver.subscribe(
      {
        processMessage: async (message) => {
          if (this.stopped) return;
          const task = this.handle(queue, receiver, message).catch((error) => {
            const code = safeSdkErrorCode(error);
            state.phase = 'DEGRADED';
            state.linkReady = false;
            state.lastErrorCode = code;
            this.recomputeQueueReady(state);
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
          if (!this.stopped) {
            state.phase = 'DEGRADED';
            state.linkReady = false;
            if (receiver.isClosed) {
              state.subscribed = false;
            }
          }
          state.lastErrorCode = code;
          this.recomputeQueueReady(state);
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
    state.subscribed = true;
    state.phase = 'SUBSCRIBED';
    state.lastErrorCode = null;
    this.recomputeQueueReady(state);
  }

  private async checkQueueLink(
    queue: CombosEventQueue,
    timeoutMs: number,
  ): Promise<boolean> {
    const state = this.states.get(queue)!;
    const receiver = this.receivers.get(queue);
    if (this.stopped) {
      state.linkReady = false;
      state.phase = 'STOPPED';
      this.recomputeQueueReady(state);
      return false;
    }
    if (!receiver || receiver.isClosed) {
      state.linkReady = false;
      state.subscribed = false;
      state.phase = 'DEGRADED';
      state.lastCheckedAt = new Date().toISOString();
      state.lastErrorCode = 'RECEIVER_CLOSED';
      this.recomputeQueueReady(state);
      return false;
    }
    try {
      await receiver.peekMessages(1, {
        abortSignal: AbortSignal.timeout(timeoutMs),
      });
      if (this.stopped || receiver.isClosed) {
        state.linkReady = false;
        if (this.stopped) state.phase = 'STOPPED';
        this.recomputeQueueReady(state);
        return false;
      }
      state.linkReady = true;
      if (state.phase === 'IDLE') {
        state.phase = 'LINK_VERIFIED';
      }
      state.lastErrorCode = null;
      state.lastCheckedAt = new Date().toISOString();
      this.recomputeQueueReady(state);
      return true;
    } catch (error) {
      const code = safeSdkErrorCode(error);
      state.linkReady = false;
      state.phase = 'DEGRADED';
      state.lastErrorCode = code;
      state.lastCheckedAt = new Date().toISOString();
      this.recomputeQueueReady(state);
      this.hooks.onConnectionError?.(queue, code, 'peek_probe');
      return false;
    }
  }

  private async teardownQueue(queue: CombosEventQueue): Promise<void> {
    const sub = this.subscriptions.get(queue);
    this.subscriptions.delete(queue);
    if (sub) {
      await sub.close().catch(() => undefined);
    }
    const rx = this.receivers.get(queue);
    this.receivers.delete(queue);
    if (rx && !rx.isClosed) {
      await rx.close().catch(() => undefined);
    }
  }

  private async recoverQueueIfNeeded(queue: CombosEventQueue): Promise<void> {
    if (this.stopped) return;
    const existing = this.recovering.get(queue);
    if (existing) return existing;

    const task = (async () => {
      if (this.stopped) return;
      const state = this.states.get(queue)!;
      const receiver = this.receivers.get(queue);
      const hasSub = this.subscriptions.has(queue);
      if (
        state.phase === 'SUBSCRIBED' &&
        state.linkReady &&
        state.subscribed &&
        hasSub &&
        receiver &&
        !receiver.isClosed
      ) {
        await this.checkQueueLink(queue, 2000);
        if (state.phase === 'SUBSCRIBED' && state.linkReady) return;
      }

      if (this.stopped) return;
      if (Date.now() < (this.nextRecoveryAt.get(queue) ?? 0)) {
        return;
      }
      state.phase = 'RECOVERING';
      state.linkReady = false;
      state.subscribed = false;
      this.recomputeQueueReady(state);

      await this.teardownQueue(queue);
      if (this.stopped) return;

      try {
        this.createQueueReceiver(queue);
        const ok = await this.checkQueueLink(queue, 3000);
        if (ok && !this.stopped) {
          this.clearQueueFailure(queue);
          this.subscribeQueue(queue);
          this.hooks.onLog?.('log', {
            event: 'service_bus_receiver_recovered',
            queue,
          });
        } else if (!this.stopped) {
          await this.teardownQueue(queue);
          this.recordQueueFailure(queue);
          state.phase = 'DEGRADED';
          this.recomputeQueueReady(state);
        }
      } catch (error) {
        const code = safeSdkErrorCode(error);
        await this.teardownQueue(queue);
        this.recordQueueFailure(queue);
        state.phase = this.stopped ? 'STOPPED' : 'DEGRADED';
        state.linkReady = false;
        state.subscribed = false;
        state.lastErrorCode = code;
        this.recomputeQueueReady(state);
        this.hooks.onConnectionError?.(queue, code, 'recovery');
      }
    })().finally(() => {
      this.recovering.delete(queue);
    });

    this.recovering.set(queue, task);
    return task;
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
        state.phase = 'STOPPED';
        state.linkReady = false;
        state.subscribed = false;
        state.ready = false;
      }
      await Promise.allSettled([...this.recovering.values()]);
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
