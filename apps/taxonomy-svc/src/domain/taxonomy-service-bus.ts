import { ManagedIdentityCredential } from '@azure/identity';
import {
  ServiceBusClient,
  type ServiceBusReceivedMessage,
} from '@azure/service-bus';
import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Database } from '../database.js';
import { esUuid } from '../errors/taxonomy.errors.js';
import {
  parseChecked,
  TaxonomyMessageStore,
} from '../persistence/taxonomy-message.store.js';

export const TAXONOMY_CATALOG_QUEUE = 'g6.catalog.from.taxonomy';
export const CATALOG_TAXONOMY_QUEUE = 'g6.taxonomy.from.catalog';
const outgoing = new Set([
  'taxonomy.category.updated',
  'taxonomy.product-type-schema.changed',
  'taxonomy.characteristic-value.updated',
  'taxonomy.master.deactivation.check.requested',
  'taxonomy.master.deactivated',
  'taxonomy.master.deactivation.rejected',
]);

export function leerServiceBus(
  env: Readonly<NodeJS.ProcessEnv>,
): { namespace: string; clientId?: string } | undefined {
  if (!env.MESSAGING_PROVIDER || env.MESSAGING_PROVIDER === 'RABBITMQ') {
    if (
      env.TAXONOMY_SERVICE_BUS_ENABLED !== undefined &&
      env.TAXONOMY_SERVICE_BUS_ENABLED !== 'false'
    )
      throw new Error('TAXONOMY_MESSAGING_CONFIGURATION_INVALID');
    return undefined;
  }
  const namespace = env.SERVICE_BUS_NAMESPACE_FQDN ?? '';
  const clientId = env.AZURE_CLIENT_ID;
  if (
    env.MESSAGING_PROVIDER !== 'AZURE_SERVICE_BUS' ||
    env.TAXONOMY_SERVICE_BUS_ENABLED !== 'true' ||
    !/^[a-z][a-z0-9-]{4,48}[a-z0-9]\.servicebus\.windows\.net$/i.test(
      namespace,
    ) ||
    env.NODE_ENV !== 'test' ||
    !namespace.toLowerCase().startsWith('g6-sb-test-') ||
    (clientId !== undefined && !esUuid(clientId)) ||
    env.RABBITMQ_URL ||
    env.TAXONOMY_CATALOG_AMQP_USER
  )
    throw new Error('TAXONOMY_MESSAGING_CONFIGURATION_INVALID');
  return { namespace, ...(clientId ? { clientId } : {}) };
}

export async function verificarPersistenciaServiceBus(
  database: Database,
): Promise<void> {
  const result = await database.read((db) =>
    db.execute(sql`
    SELECT CASE WHEN to_regclass('taxonomy.outbox_delivery') IS NULL THEN false ELSE
      has_table_privilege(current_user, 'taxonomy.outbox_delivery', 'SELECT') AND
      has_table_privilege(current_user, 'taxonomy.outbox_delivery', 'UPDATE') AND NOT EXISTS (
        SELECT 1 FROM taxonomy.outbox o WHERE o.published_at IS NULL AND o.event_name IN (
          'taxonomy.category.updated', 'taxonomy.product-type-schema.changed',
          'taxonomy.characteristic-value.updated', 'taxonomy.master.deactivation.check.requested',
          'taxonomy.master.deactivated', 'taxonomy.master.deactivation.rejected'
        ) AND NOT EXISTS (SELECT 1 FROM taxonomy.outbox_delivery d
          WHERE d.message_id = o.message_id AND d.destination = 'g6.catalog.from.taxonomy')
      ) AND EXISTS (
        SELECT 1 FROM pg_catalog.pg_trigger
        WHERE tgrelid = 'taxonomy.outbox'::regclass
          AND tgname = 'taxonomy_enqueue_catalog_delivery_h5' AND NOT tgisinternal AND tgenabled <> 'D'
      ) END AS ready
  `),
  );
  if (result.rows[0]?.ready !== true)
    throw new Error('TAXONOMY_SERVICE_BUS_STORAGE_NOT_READY');
}

type Receiver = Pick<
  ReturnType<ServiceBusClient['createReceiver']>,
  'completeMessage' | 'abandonMessage' | 'deadLetterMessage'
>;
type Sender = Pick<
  ReturnType<ServiceBusClient['createSender']>,
  'createMessageBatch' | 'sendMessages'
>;
type Store = Pick<TaxonomyMessageStore, 'consumir' | 'publicarUnoServiceBus'>;

/** Transport-independent processing; SQL Inbox must commit before completing Peek-Lock. */
export class TaxonomyServiceBusBridge {
  constructor(
    private readonly store: Store,
    private readonly sender: Sender,
    private readonly receiver: Receiver,
  ) {}

  async publicarUno(): Promise<'VACIO' | 'PENDIENTE' | 'PUBLICADO'> {
    return this.store.publicarUnoServiceBus(async (row) => {
      const payload = row.payload;
      if (
        !payload ||
        typeof payload !== 'object' ||
        Array.isArray(payload) ||
        typeof row.event_name !== 'string' ||
        !outgoing.has(row.event_name) ||
        typeof row.message_id !== 'string' ||
        !esUuid(row.message_id) ||
        typeof row.correlation_id !== 'string' ||
        !esUuid(row.correlation_id)
      )
        throw new Error('INVALID_OUTBOX');
      const envelope = payload as Record<string, unknown>;
      const kind = row.event_name.endsWith('.requested')
        ? 'command'
        : row.event_name.endsWith('.rejected')
          ? 'result'
          : 'event';
      if (
        envelope.name !== row.event_name ||
        envelope.message_id !== row.message_id ||
        envelope.correlation_id !== row.correlation_id ||
        envelope.producer !== 'taxonomy-svc' ||
        envelope.schema_version !== 1 ||
        envelope.kind !== kind ||
        !envelope.data ||
        typeof envelope.data !== 'object' ||
        Array.isArray(envelope.data)
      )
        throw new Error('INVALID_OUTBOX');
      const batch = await this.sender.createMessageBatch({
        maxSizeInBytes: 256 * 1024,
        abortSignal: AbortSignal.timeout(10_000),
      });
      if (
        !batch.tryAddMessage({
          body: Buffer.from(JSON.stringify(payload)),
          contentType: 'application/json',
          messageId: row.message_id,
          correlationId: row.correlation_id,
          subject: row.event_name,
        })
      )
        throw new Error('SERVICE_BUS_MESSAGE_TOO_LARGE');
      await this.sender.sendMessages(batch, {
        abortSignal: AbortSignal.timeout(10_000),
      });
    });
  }

  async recibir(message: ServiceBusReceivedMessage): Promise<void> {
    let envelope;
    try {
      if (
        message.contentType !== 'application/json' ||
        !Buffer.isBuffer(message.body) ||
        message.body.length > 256 * 1024
      )
        throw new Error('INVALID_ENVELOPE');
      envelope = parseChecked(
        JSON.parse(message.body.toString('utf8')) as unknown,
      );
      if (
        message.messageId !== envelope.message_id ||
        message.correlationId !== envelope.correlation_id ||
        message.subject !== envelope.name
      )
        throw new Error('INVALID_ENVELOPE');
    } catch {
      await this.receiver.deadLetterMessage(message, {
        deadLetterReason: 'INVALID_TAXONOMY_MESSAGE',
        deadLetterErrorDescription: 'Invalid envelope or transport metadata.',
      });
      return;
    }
    try {
      await this.store.consumir(envelope);
    } catch {
      await this.receiver.abandonMessage(message);
      return;
    }
    // If settlement fails after commit, redelivery is deduplicated by SQL Inbox.
    await this.receiver.completeMessage(message);
  }
}

@Injectable()
export class TaxonomyServiceBusRuntime implements OnModuleDestroy {
  private readonly logger = new Logger(TaxonomyServiceBusRuntime.name);
  private config?: ReturnType<typeof leerServiceBus>;
  private client?: ServiceBusClient;
  private receiver?: ReturnType<ServiceBusClient['createReceiver']>;
  private sender?: ReturnType<ServiceBusClient['createSender']>;
  private subscription?: ReturnType<
    ReturnType<ServiceBusClient['createReceiver']>['subscribe']
  >;
  private timer?: ReturnType<typeof setTimeout>;
  private active?: Promise<void>;
  private stopped = false;
  private ready = false;
  constructor(private readonly store: TaxonomyMessageStore) {}
  configurar(env: Readonly<NodeJS.ProcessEnv>): void {
    this.config = leerServiceBus(env);
  }
  disponible(): boolean {
    return !this.config || this.ready;
  }
  iniciar(): void {
    if (!this.config || this.client || this.stopped) return;
    const credential = this.config.clientId
      ? new ManagedIdentityCredential({ clientId: this.config.clientId })
      : new ManagedIdentityCredential();
    this.client = new ServiceBusClient(this.config.namespace, credential, {
      retryOptions: { maxRetries: 0, timeoutInMs: 5000 },
    });
    this.sender = this.client.createSender(TAXONOMY_CATALOG_QUEUE);
    this.receiver = this.client.createReceiver(CATALOG_TAXONOMY_QUEUE, {
      receiveMode: 'peekLock',
    });
    const bridge = new TaxonomyServiceBusBridge(
      this.store,
      this.sender,
      this.receiver,
    );
    this.subscription = this.receiver.subscribe(
      {
        processMessage: async (message) => {
          await bridge.recibir(message);
        },
        processError: async () => {
          this.ready = false;
          this.logger.warn('TAXONOMY_SERVICE_BUS_CONSUMER_UNAVAILABLE');
        },
      },
      { autoCompleteMessages: false, maxConcurrentCalls: 1 },
    );
    const tick = () => {
      let delay = 5000;
      this.active = (async () => {
        const state = await bridge.publicarUno();
        if (state === 'PUBLICADO') delay = 1000;
        this.ready = state !== 'PENDIENTE';
        if (state === 'PENDIENTE')
          this.logger.warn('TAXONOMY_SERVICE_BUS_OUTBOX_PENDING');
      })()
        .catch(() => {
          this.ready = false;
          this.logger.warn('TAXONOMY_SERVICE_BUS_OUTBOX_UNAVAILABLE');
        })
        .finally(() => {
          if (!this.stopped) this.timer = setTimeout(tick, delay);
        });
    };
    tick();
  }
  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.active;
    await this.subscription?.close();
    await this.receiver?.close();
    await this.sender?.close();
    await this.client?.close();
    this.ready = false;
  }
}
