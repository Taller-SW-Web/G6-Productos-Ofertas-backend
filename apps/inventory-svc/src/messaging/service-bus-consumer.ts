/**
 * Consumidor punto a punto Azure Service Bus para inventory-svc (H5).
 *
 * Flujo R06:
 *   Cola: g6.inventory.from.catalog
 *   Eventos autorizados:
 *     - inventory.sku.initialization.requested
 *     - catalog.sku.deactivated (respetando CATALOG_SKU_DEACTIVATION_ENABLED)
 *
 * Flujo R02 / Bulk:
 *   Cola: g6.inventory.from.bulk
 *   Evento autorizado: inventory.bulk.stock.adjust.requested (producer === 'bulk-svc').
 *
 * Idempotencia y durabilidad:
 *   - Modo PeekLock.
 *   - Validación estricta de envelope (subject === payload.name, messageId === payload.message_id como UUIDs válidos, producer === 'catalog-svc').
 *   - DLQ inmediato para violaciones de contrato, INVALID_MESSAGE y FEATURE_DISABLED.
 *   - Errores transitorios aplican retardo exponencial (1, 2, 4, 8, hasta 16s según deliveryCount) antes de abandonMessage.
 *   - Commit durable antes de completeMessage.
 */

import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import {
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from '@azure/identity';
import {
  ServiceBusClient,
  type ServiceBusReceivedMessage,
  type ServiceBusReceiver,
} from '@azure/service-bus';
import {
  InventoryCommandService,
  InventoryMessageError,
} from '../inbox/inventory-command.service.js';
import { loadInventoryConfig } from '../config/inventory.config.js';

export const QUEUE_CATALOG = 'g6.inventory.from.catalog';
export const QUEUE_BULK = 'g6.inventory.from.bulk';

const ACCEPTED_EVENTS = new Set([
  'inventory.sku.initialization.requested',
  'catalog.sku.deactivated',
  'inventory.bulk.stock.adjust.requested',
]);

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type InventoryBusSettlement = Pick<
  ServiceBusReceiver,
  'completeMessage' | 'abandonMessage' | 'deadLetterMessage'
>;

export type DelayFn = (ms: number) => Promise<void>;
const defaultDelay: DelayFn = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

export function computeTransientBackoffMs(deliveryCount?: number): number {
  const count =
    typeof deliveryCount === 'number' && deliveryCount > 0 ? deliveryCount : 1;
  const exp = Math.min(count - 1, 4);
  const seconds = Math.min(16, Math.pow(2, exp));
  return seconds * 1000;
}

export class InventoryServiceBusHandler {
  constructor(
    private readonly commands: Pick<InventoryCommandService, 'process'>,
    private readonly receiver: InventoryBusSettlement,
    private readonly delay: DelayFn = defaultDelay,
    private readonly queueName: string = 'g6.inventory',
  ) {}

  async handle(
    message: ServiceBusReceivedMessage,
  ): Promise<'completed' | 'abandoned' | 'dead-lettered'> {
    let payload: unknown;
    try {
      const body: unknown = message.body;
      const content =
        typeof body === 'string'
          ? Buffer.from(body, 'utf8')
          : body instanceof Uint8Array
            ? body
            : typeof body === 'object' && body !== null
              ? Buffer.from(JSON.stringify(body), 'utf8')
              : undefined;

      if (!content || content.byteLength > 256 * 1024) {
        throw new Error('INVALID_ENVELOPE_CONTENT');
      }

      // Validar message.messageId como UUID válido
      if (
        typeof message.messageId !== 'string' ||
        !UUID_REGEX.test(message.messageId.trim())
      ) {
        throw new Error('INVALID_BROKER_MESSAGE_ID');
      }

      // Validar message.subject existente y no vacío
      if (
        typeof message.subject !== 'string' ||
        message.subject.trim().length === 0
      ) {
        throw new Error('INVALID_BROKER_SUBJECT');
      }

      payload = JSON.parse(content.toString('utf8'));

      if (
        !payload ||
        typeof payload !== 'object' ||
        !('name' in payload) ||
        typeof (payload as Record<string, unknown>).name !== 'string'
      ) {
        throw new Error('INVALID_ENVELOPE');
      }

      const p = payload as Record<string, unknown>;
      const eventName = p.name as string;

      // Validación estricta: correspondencia exacta entre subject del mensaje y name del envelope
      if (message.subject !== eventName) {
        throw new Error('SUBJECT_MISMATCH');
      }

      // Validación de payload.message_id como UUID válido y coincidencia exacta con message.messageId
      if (
        typeof p.message_id !== 'string' ||
        !UUID_REGEX.test(p.message_id.trim()) ||
        message.messageId !== p.message_id
      ) {
        throw new Error('MESSAGE_ID_MISMATCH');
      }

      // Validación de emisor legítimo: R06 (catalog-svc) o R02 (bulk-svc)
      const expectedProducer =
        eventName === 'inventory.bulk.stock.adjust.requested'
          ? 'bulk-svc'
          : 'catalog-svc';
      if (p.producer !== expectedProducer) {
        throw new Error('PRODUCER_MISMATCH');
      }

      if (!ACCEPTED_EVENTS.has(eventName)) {
        throw new Error('UNKNOWN_EVENT_TYPE');
      }
    } catch (err) {
      console.error('[inventory-sb-consumer] invalid contract error:', err);
      await this.receiver.deadLetterMessage(message, {
        deadLetterReason: 'INVALID_INVENTORY_CONTRACT',
        deadLetterErrorDescription:
          'El envelope o payload no cumple el contrato aprobado de Inventory.',
      });
      return 'dead-lettered';
    }

    try {
      await this.commands.process(payload);
    } catch (error) {
      if (error instanceof InventoryMessageError) {
        console.error(
          '[inventory-sb-consumer] InventoryMessageError:',
          error.reason,
          error,
        );
        // INVALID_MESSAGE, BLOCKED_CONTRACT o FEATURE_DISABLED van a DLQ de inmediato sin bucle de reintentos
        await this.receiver.deadLetterMessage(message, {
          deadLetterReason: error.reason,
          deadLetterErrorDescription: `Rechazado por InventoryCommandService: ${error.reason}`,
        });
        return 'dead-lettered';
      }

      const rawMaxDeliveries = Number(
        process.env.INVENTORY_SB_MAX_TRANSIENT_DELIVERIES ?? 15,
      );
      const maxTransientDeliveries =
        Number.isSafeInteger(rawMaxDeliveries) && rawMaxDeliveries > 0
          ? rawMaxDeliveries
          : 15;
      const deliveryCount = message.deliveryCount ?? 1;
      const bodyObj =
        typeof payload === 'object' && payload !== null
          ? (payload as Record<string, unknown>)
          : {};
      const dataObj =
        typeof bodyObj.data === 'object' && bodyObj.data !== null
          ? (bodyObj.data as Record<string, unknown>)
          : {};
      console.error(
        JSON.stringify({
          level: deliveryCount >= maxTransientDeliveries ? 'error' : 'warn',
          service: 'inventory-svc',
          queue: this.queueName,
          event: bodyObj.name ?? message.subject ?? null,
          message_id: bodyObj.message_id ?? message.messageId ?? null,
          correlation_id:
            bodyObj.correlation_id ?? message.correlationId ?? null,
          sku: dataObj.sku ?? null,
          location_id:
            dataObj.location_id ?? dataObj.default_location_id ?? null,
          delivery_count: deliveryCount,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      if (deliveryCount >= maxTransientDeliveries) {
        await this.receiver.deadLetterMessage(message, {
          deadLetterReason: 'TRANSIENT_RETRY_EXHAUSTED',
          deadLetterErrorDescription:
            error instanceof Error
              ? error.message
              : 'Se agotaron los reintentos transitorios en Inventory.',
        });
        return 'dead-lettered';
      }

      // Error transitorio (DB, deadlock, red): aplicar retardo de 1, 2, 4, 8 hasta 16s según deliveryCount antes de abandonMessage
      const delayMs =
        process.env.NODE_ENV === 'test' &&
        process.env.G6_ISOLATED_SERVICE_BUS_URL
          ? 300
          : computeTransientBackoffMs(message.deliveryCount);
      await this.delay(delayMs);
      await this.receiver.abandonMessage(message);
      return 'abandoned';
    }

    // Completar únicamente tras persistencia y commit exitoso
    await this.receiver.completeMessage(message);
    return 'completed';
  }
}

@Injectable()
export class InventoryServiceBusConsumerRuntime
  implements OnApplicationBootstrap, OnModuleDestroy
{
  available = false;
  private client?: ServiceBusClient;
  private receiver?: ServiceBusReceiver;
  private bulkReceiver?: ServiceBusReceiver;
  private subscription?: { close(): Promise<void> };
  private bulkSubscription?: { close(): Promise<void> };
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private isOpening = false;
  private stopped = false;
  private readonly active = new Set<Promise<unknown>>();
  private readonly logger = new Logger(InventoryServiceBusConsumerRuntime.name);

  constructor(private readonly commands: InventoryCommandService) {}

  onApplicationBootstrap(): void {
    const config = loadInventoryConfig();
    if (!config.serviceBus || !config.serviceBus.consumeEnabled) return;

    if (config.serviceBus.isolatedBusUrl) {
      const origin = config.serviceBus.isolatedBusUrl;
      const timers = new Set<ReturnType<typeof setInterval>>();
      this.client = {
        createReceiver(queue: string) {
          return {
            async peekMessages() {
              const res = await fetch(
                `${origin}/queues/${encodeURIComponent(queue)}/peek`,
              );
              if (!res.ok)
                throw new Error(`ISOLATED_BUS_PEEK_FAILED_${res.status}`);
              return (await res.json()) as ServiceBusReceivedMessage[];
            },
            subscribe(handlers: {
              processMessage: (msg: ServiceBusReceivedMessage) => Promise<void>;
              processError: (args: { error: Error }) => Promise<void>;
            }) {
              let active = true;
              const timer = setInterval(async () => {
                if (!active) return;
                try {
                  const res = await fetch(
                    `${origin}/queues/${encodeURIComponent(queue)}/receive`,
                    { method: 'POST' },
                  );
                  if (res.status === 204 || !res.ok) return;
                  const msg = (await res.json()) as {
                    deliveryId: string;
                    body: string;
                    contentType?: string;
                    messageId?: string;
                    correlationId?: string;
                    subject?: string;
                    applicationProperties?: Record<string, unknown>;
                    deliveryCount?: number;
                  };
                  await handlers.processMessage({
                    body: Buffer.from(msg.body, 'utf8'),
                    contentType: msg.contentType,
                    messageId: msg.messageId,
                    correlationId: msg.correlationId,
                    subject: msg.subject,
                    applicationProperties: msg.applicationProperties,
                    deliveryCount: msg.deliveryCount ?? 1,
                    _deliveryId: msg.deliveryId,
                  } as unknown as ServiceBusReceivedMessage);
                } catch (error) {
                  await handlers.processError({
                    error:
                      error instanceof Error ? error : new Error(String(error)),
                  });
                }
              }, 250);
              timer.unref();
              timers.add(timer);
              return {
                async close() {
                  active = false;
                  clearInterval(timer);
                  timers.delete(timer);
                },
              };
            },
            async completeMessage(message: ServiceBusReceivedMessage) {
              const id = (message as unknown as { _deliveryId?: string })
                ._deliveryId;
              if (!id) return;
              await fetch(
                `${origin}/queues/${encodeURIComponent(queue)}/complete/${encodeURIComponent(id)}`,
                { method: 'POST' },
              );
            },
            async abandonMessage(message: ServiceBusReceivedMessage) {
              const id = (message as unknown as { _deliveryId?: string })
                ._deliveryId;
              if (!id) return;
              await fetch(
                `${origin}/queues/${encodeURIComponent(queue)}/abandon/${encodeURIComponent(id)}`,
                { method: 'POST' },
              );
            },
            async deadLetterMessage(
              message: ServiceBusReceivedMessage,
              options?: {
                deadLetterReason?: string;
                deadLetterErrorDescription?: string;
              },
            ) {
              const id = (message as unknown as { _deliveryId?: string })
                ._deliveryId;
              if (!id) return;
              await fetch(
                `${origin}/queues/${encodeURIComponent(queue)}/deadletter/${encodeURIComponent(id)}`,
                {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify(options ?? {}),
                },
              );
            },
            async close() {
              for (const t of timers) clearInterval(t);
              timers.clear();
            },
          } as unknown as ServiceBusReceiver;
        },
        async close() {
          for (const t of timers) clearInterval(t);
          timers.clear();
        },
      } as unknown as ServiceBusClient;
    } else {
      this.client = new ServiceBusClient(
        config.serviceBus.namespace,
        config.serviceBus.managedIdentityClientId
          ? new ManagedIdentityCredential({
              clientId: config.serviceBus.managedIdentityClientId,
            })
          : new DefaultAzureCredential(),
        {
          retryOptions: { maxRetries: 0, timeoutInMs: 5000 },
        },
      );
    }

    // Solo se suscribe al flujo R06 (Catalog → Inventory); Bulk (R02) permanece bloqueado.
    void this.open();
  }

  private async open(): Promise<void> {
    if (this.stopped || this.isOpening || !this.client) return;
    this.isOpening = true;

    try {
      // Cierra la suscripción anterior antes de crear la siguiente.
      // Si falla subscription.close(), intenta cerrar el receiver.
      // Si receiver.close() también falla, conserva las referencias y no crea otro receiver ni otra suscripción.
      // Solo libera las referencias después del cierre confirmado.
      if (this.subscription) {
        try {
          await this.subscription.close();
          this.subscription = undefined;
        } catch (closeErr) {
          if (this.receiver) {
            await this.receiver.close();
            this.receiver = undefined;
          }
          this.subscription = undefined;
          throw closeErr;
        }
      }

      if (this.bulkSubscription) {
        try {
          await this.bulkSubscription.close();
          this.bulkSubscription = undefined;
        } catch (closeErr) {
          if (this.bulkReceiver) {
            await this.bulkReceiver.close();
            this.bulkReceiver = undefined;
          }
          this.bulkSubscription = undefined;
          throw closeErr;
        }
      }

      this.receiver ??= this.client.createReceiver(QUEUE_CATALOG, {
        receiveMode: 'peekLock',
        skipParsingBodyAsJson: true,
        maxAutoLockRenewalDurationInMs: 60_000,
      });
      this.bulkReceiver ??= this.client.createReceiver(QUEUE_BULK, {
        receiveMode: 'peekLock',
        skipParsingBodyAsJson: true,
        maxAutoLockRenewalDurationInMs: 60_000,
      });

      await this.receiver.peekMessages(1);
      await this.bulkReceiver.peekMessages(1);
      if (this.stopped) return;

      const handler = new InventoryServiceBusHandler(
        this.commands,
        this.receiver,
        defaultDelay,
        'g6.inventory.from.catalog',
      );
      const bulkHandler = new InventoryServiceBusHandler(
        this.commands,
        this.bulkReceiver,
        defaultDelay,
        'g6.inventory.from.bulk',
      );

      this.subscription = this.receiver.subscribe(
        {
          processMessage: async (msg) => {
            const task = handler.handle(msg);
            this.active.add(task);
            try {
              await task;
              this.available = true;
            } catch (error) {
              this.available = false;
              throw error;
            } finally {
              this.active.delete(task);
            }
          },
          processError: async () => {
            this.available = false;
            this.logger.warn(
              `SERVICE_BUS_INVENTORY_CONSUMER_RECOVERY_PENDING [${QUEUE_CATALOG}]`,
            );
            this.scheduleReconnect();
          },
        },
        { autoCompleteMessages: false, maxConcurrentCalls: 1 },
      );

      this.bulkSubscription = this.bulkReceiver.subscribe(
        {
          processMessage: async (msg) => {
            const task = bulkHandler.handle(msg);
            this.active.add(task);
            try {
              await task;
              this.available = true;
            } catch (error) {
              this.available = false;
              throw error;
            } finally {
              this.active.delete(task);
            }
          },
          processError: async () => {
            this.available = false;
            this.logger.warn(
              `SERVICE_BUS_INVENTORY_CONSUMER_RECOVERY_PENDING [${QUEUE_BULK}]`,
            );
            this.scheduleReconnect();
          },
        },
        { autoCompleteMessages: false, maxConcurrentCalls: 1 },
      );

      this.available = true;
    } catch {
      this.available = false;
      this.scheduleReconnect();
    } finally {
      this.isOpening = false;
    }
  }

  private scheduleReconnect(): void {
    if (!this.stopped && !this.reconnectTimer) {
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = undefined;
        void this.open();
      }, 2000);
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    try {
      if (this.subscription) {
        await Promise.resolve(this.subscription.close()).catch(() => undefined);
        this.subscription = undefined;
      }
      if (this.bulkSubscription) {
        await Promise.resolve(this.bulkSubscription.close()).catch(
          () => undefined,
        );
        this.bulkSubscription = undefined;
      }
      await Promise.allSettled(this.active);
    } finally {
      this.available = false;
      try {
        await Promise.resolve(this.receiver?.close()).catch(() => undefined);
        await Promise.resolve(this.bulkReceiver?.close()).catch(
          () => undefined,
        );
      } finally {
        this.receiver = undefined;
        this.bulkReceiver = undefined;
        await Promise.resolve(this.client?.close()).catch(() => undefined);
        this.client = undefined;
      }
    }
  }
}
