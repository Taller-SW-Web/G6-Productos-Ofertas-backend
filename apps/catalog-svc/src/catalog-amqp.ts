import {
  Inject,
  Injectable,
  type OnModuleInit,
  type OnModuleDestroy,
} from '@nestjs/common';
import {
  connect,
  type Channel,
  type ChannelModel,
  type ConfirmChannel,
  type ConsumeMessage,
  type Options,
} from 'amqplib';
import {
  CatalogMessageService,
  type CatalogPublisher,
} from './catalog-message.service.js';
import {
  BlockedCatalogHandler,
  InvalidCatalogMessage,
  catalogProduced,
  assertCatalogPublication,
  parseCatalogMessage,
  type CatalogEnvelope,
} from './catalog-messages.js';
import { object } from './catalog-mutation.input.js';

export interface CatalogAmqpConfig {
  url: string;
  user: string;
  producerUsers: Record<string, string>;
}
export const CATALOG_AMQP_SETTINGS = Symbol('CATALOG_AMQP_SETTINGS');
export interface CatalogAmqpSettings {
  connection?: CatalogAmqpConfig;
}
export function readCatalogAmqpConfig(
  env: Record<string, string | undefined> = process.env,
): CatalogAmqpConfig | undefined {
  if (!env.RABBITMQ_URL) return undefined;
  try {
    const url = new URL(env.RABBITMQ_URL);
    const users: unknown = JSON.parse(
      env.CATALOG_AMQP_PRODUCER_USERS ?? 'null',
    );
    if (
      !['amqp:', 'amqps:'].includes(url.protocol) ||
      decodeURIComponent(url.pathname.slice(1)) !== 'g6-productos-ofertas' ||
      !url.username ||
      !url.password ||
      !object(users) ||
      ['pricing-svc', 'inventory-svc', 'taxonomy-svc', 'bulk-svc'].some(
        (k) => typeof users[k] !== 'string' || !users[k],
      )
    )
      throw new Error();
    if (
      new Set(Object.values(users)).size !== Object.values(users).length ||
      Object.values(users).includes(decodeURIComponent(url.username))
    )
      throw new Error();
    return {
      url: env.RABBITMQ_URL,
      user: decodeURIComponent(url.username),
      producerUsers: users as Record<string, string>,
    };
  } catch {
    throw new Error(
      'Configuración RabbitMQ de Catálogo inválida; requiere vhost y usuarios de productores explícitos.',
    );
  }
}

/** Publisher confirms only broker responsibility; a confirm is never business completion. */
export class ConfirmedCatalogPublisher implements CatalogPublisher {
  private tail: Promise<void> = Promise.resolve();
  constructor(
    private readonly channel: ConfirmChannel,
    private readonly user: string,
    private readonly timeout = 5000,
  ) {}
  publish(message: CatalogEnvelope): Promise<void> {
    try {
      assertCatalogPublication(message);
    } catch (error) {
      return Promise.reject(error);
    }
    if (!(catalogProduced as readonly string[]).includes(message.name))
      return Promise.reject(new InvalidCatalogMessage());
    const exchange =
      message.kind === 'command'
        ? 'po.commands.x'
        : message.kind === 'event'
          ? 'po.events.x'
          : 'po.results.x';
    return this.raw(
      exchange,
      message.name,
      Buffer.from(JSON.stringify(message)),
      {
        messageId: message.message_id,
        correlationId: message.correlation_id,
        type: message.name,
      },
    );
  }
  raw(
    exchange: string,
    key: string,
    content: Buffer,
    properties: Options.Publish,
  ): Promise<void> {
    const work = this.tail.then(() =>
      this.send(exchange, key, content, properties),
    );
    this.tail = work.catch(() => undefined);
    return work;
  }
  private send(
    exchange: string,
    key: string,
    content: Buffer,
    properties: Options.Publish,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      let returned = false,
        confirmed = false,
        drained = false,
        finished = false;
      const finish = (error?: unknown) => {
        if (finished) return;
        if (!error && (!confirmed || !drained)) return;
        finished = true;
        clearTimeout(timer);
        this.channel.off('return', onReturn);
        this.channel.off('close', onClose);
        this.channel.off('error', onClose);
        this.channel.off('drain', onDrain);
        if (error) reject(new Error('AMQP_PUBLISH_UNCONFIRMED'));
        else resolve();
      };
      const onReturn = () => {
        returned = true;
      };
      const onClose = () => finish(new Error());
      const onDrain = () => {
        drained = true;
        finish();
      };
      const timer = setTimeout(() => {
        finish(new Error());
        void this.channel.close().catch(() => undefined);
      }, this.timeout);
      this.channel.on('return', onReturn);
      this.channel.on('close', onClose);
      this.channel.on('error', onClose);
      this.channel.on('drain', onDrain);
      try {
        const writable = this.channel.publish(
          exchange,
          key,
          content,
          {
            ...properties,
            contentType: 'application/json',
            persistent: true,
            mandatory: true,
            userId: this.user,
          },
          (error: unknown) => {
            confirmed = true;
            finish(error || returned ? new Error() : undefined);
          },
        );
        if (writable) {
          drained = true;
          finish();
        }
      } catch {
        finish(new Error());
      }
    });
  }
}

@Injectable()
export class CatalogAmqpRuntime implements OnModuleInit, OnModuleDestroy {
  private get config() {
    return this.settings.connection;
  }
  private connection?: ChannelModel;
  private consumer?: Channel;
  private publisher?: ConfirmedCatalogPublisher;
  private timer?: ReturnType<typeof setInterval>;
  private busy = false;
  private stopped = false;
  private deliveries = new Set<Promise<void>>();
  constructor(
    private readonly messages: CatalogMessageService,
    @Inject(CATALOG_AMQP_SETTINGS)
    private readonly settings: CatalogAmqpSettings = {
      connection: readCatalogAmqpConfig(),
    },
  ) {}
  onModuleInit(): void {
    if (!this.config) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, 2000);
    this.timer.unref();
    void this.tick();
  }
  private async tick(): Promise<void> {
    if (this.busy || this.stopped || !this.config) return;
    this.busy = true;
    try {
      if (!this.connection) {
        const connection = await connect(this.config.url, { timeout: 5000 });
        if (this.stopped) {
          await connection.close();
          return;
        }
        connection.on('error', () => this.log('AMQP_CONNECTION_FAILURE'));
        connection.on('close', () => {
          if (this.connection === connection) {
            this.connection = undefined;
            this.publisher = undefined;
            this.consumer = undefined;
          }
        });
        this.connection = connection;
        try {
          const channel = await connection.createConfirmChannel();
          channel.on('error', () => this.log('AMQP_CHANNEL_FAILURE'));
          channel.on('close', () => {
            void this.reset(connection);
          });
          this.publisher = new ConfirmedCatalogPublisher(
            channel,
            this.config.user,
          );
          this.consumer = await connection.createChannel();
          this.consumer.on('error', () => this.log('AMQP_CONSUMER_FAILURE'));
          this.consumer.on('close', () => {
            void this.reset(connection);
          });
          await this.consumer.prefetch(20);
          const consumer = this.consumer,
            publisher = this.publisher;
          // Infrastructure owns topology. No assert, bind, purge or declare against shared brokers.
          await consumer.consume(
            'po.catalog.q',
            (delivery) => {
              if (!delivery) return;
              const processing = this.handle(
                delivery,
                consumer,
                publisher,
              ).catch(() => this.reset(connection));
              this.deliveries.add(processing);
              void processing.finally(() => this.deliveries.delete(processing));
            },
            { noAck: false },
          );
        } catch (error) {
          await this.reset(connection);
          throw error;
        }
      }
      for (let i = 0; i < 20 && !this.stopped && this.publisher; i++) {
        if ((await this.messages.relayOne(this.publisher)) !== 'PUBLISHED')
          break;
      }
    } catch {
      this.log('AMQP_CYCLE_PENDING');
    } finally {
      this.busy = false;
    }
  }
  private async handle(
    delivery: ConsumeMessage,
    consumer: Channel,
    publisher: ConfirmedCatalogPublisher,
  ): Promise<void> {
    let malformed = false;
    const count: unknown = delivery.properties.headers?.['x-retry-count'] ?? 0;
    let attempt =
      typeof count === 'number' &&
      Number.isInteger(count) &&
      count >= 0 &&
      count <= 3
        ? count
        : 3;
    let origin = delivery.properties.userId;
    try {
      if (
        delivery.content.length > 1024 * 1024 ||
        delivery.properties.contentType !== 'application/json'
      )
        throw new InvalidCatalogMessage();
      const message = parseCatalogMessage(
        JSON.parse(delivery.content.toString('utf8')) as unknown,
      );
      if (attempt > 0) {
        if (origin !== this.config!.user) throw new InvalidCatalogMessage();
        origin = delivery.properties.headers?.['x-original-producer-user'];
      }
      if (
        origin !== this.config!.producerUsers[message.producer] ||
        delivery.properties.messageId !== message.message_id ||
        delivery.properties.correlationId !== message.correlation_id
      )
        throw new InvalidCatalogMessage();
      await this.messages.consume(message);
      consumer.ack(delivery);
      return;
    } catch (error) {
      malformed =
        error instanceof InvalidCatalogMessage ||
        error instanceof SyntaxError ||
        error instanceof BlockedCatalogHandler;
      if (malformed) attempt = 3;
    }
    const retry = attempt < 3;
    await publisher.raw(
      retry ? 'po.retry.x' : 'po.dlx.x',
      'po.catalog.q',
      delivery.content,
      {
        messageId: delivery.properties.messageId,
        correlationId: delivery.properties.correlationId,
        type: delivery.properties.type,
        headers: {
          'x-retry-count': retry ? attempt + 1 : attempt,
          'x-original-producer-user': typeof origin === 'string' ? origin : '',
          'x-catalog-failure': malformed
            ? 'INVALID_OR_BLOCKED_CONTRACT'
            : 'TECHNICAL_FAILURE',
        },
      },
    );
    // Only after the business transaction or the confirmed retry/DLQ publish.
    consumer.ack(delivery);
  }
  private async reset(connection: ChannelModel): Promise<void> {
    if (this.connection === connection) {
      this.connection = undefined;
      this.consumer = undefined;
      this.publisher = undefined;
    }
    await connection.close().catch(() => undefined);
  }
  private log(code: string): void {
    process.stderr.write(
      JSON.stringify({ service: 'catalog-svc', code }) + '\n',
    );
  }
  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.connection) await this.reset(this.connection);
    await Promise.allSettled(this.deliveries);
  }
}
