import type { Provider } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { PromotionsConfigService } from '../infrastructure/config/promotions-config.js';
import {
  CouponAmqpPublisher,
  CouponCommandDeliveryHandler,
  type ConfirmChannelPort,
} from './coupon-amqp.js';
import {
  CouponOutbox,
  type ConfirmedResultPublisher,
} from './coupon-outbox.js';
import {
  CouponCommandProcessor,
  type CouponEvidenceProvider,
  type SqlPool,
} from './coupon-transactions.js';
import { record } from './schema-validator.js';

export const COUPON_RESOURCES = Symbol('COUPON_RESOURCES');
export const COUPON_EVIDENCE_PROVIDER = Symbol('COUPON_EVIDENCE_PROVIDER');
interface NativePool extends SqlPool {
  end(): Promise<void>;
  on(event: 'error', listener: () => void): void;
}
interface BrokerConnection {
  createConfirmChannel(): Promise<ConfirmChannelPort>;
  close(): Promise<void>;
  on(event: string, listener: () => void): void;
}
interface CouponResources {
  pool: NativePool;
  publisher: ConfirmedResultPublisher;
  onModuleDestroy(): Promise<void>;
}

// Driver entry points are checked at this JS boundary; all use remains typed by ports.
export function nativeCouponResources(
  config: PromotionsConfigService,
): CouponResources {
  const require = createRequire(import.meta.url);
  const pg: unknown = require('pg');
  const amqp: unknown = require('amqplib');
  if (
    !record(pg) ||
    typeof pg.Pool !== 'function' ||
    !record(amqp) ||
    typeof amqp.connect !== 'function'
  ) {
    throw new Error('COUPON_DRIVER_UNAVAILABLE');
  }
  const Pool = pg.Pool as new (options: Record<string, unknown>) => NativePool;
  const connect = amqp.connect as (
    url: string,
    options: Record<string, unknown>,
  ) => Promise<BrokerConnection>;
  const database = config.settings.database;
  const pool = new Pool({
    host: database.host,
    port: database.port,
    database: database.database,
    user: database.user,
    password: database.password,
    ssl: {
      rejectUnauthorized: true,
      ca: readFileSync(database.sslRootCert, 'utf8'),
    },
    max: 3,
    connectionTimeoutMillis: 3000,
    idleTimeoutMillis: 10000,
    query_timeout: 5000,
  });
  pool.on('error', () => undefined);
  let opening:
    | Promise<{ connection: BrokerConnection; channel: ConfirmChannelPort }>
    | undefined;
  let closed = false;
  async function transport() {
    if (closed) throw new Error('COUPON_TRANSPORT_CLOSED');
    if (!opening) {
      const pending = (async () => {
        const connection = await connect(config.settings.rabbitmqUrl, {
          timeout: 3000,
        });
        connection.on('error', () => undefined);
        connection.on('close', () => {
          if (opening === pending) opening = undefined;
        });
        try {
          const channel = await connection.createConfirmChannel();
          channel.on('error', () => undefined);
          channel.on('close', () => {
            if (opening === pending) opening = undefined;
            void connection.close().catch(() => undefined);
          });
          if (closed) {
            await connection.close();
            throw new Error('COUPON_TRANSPORT_CLOSED');
          }
          return { connection, channel };
        } catch {
          await connection.close().catch(() => undefined);
          throw new Error('COUPON_TRANSPORT_UNAVAILABLE');
        }
      })();
      opening = pending;
      void pending.catch(() => {
        if (opening === pending) opening = undefined;
      });
    }
    return opening;
  }
  return {
    pool,
    publisher: {
      publishConfirmed: async (result) => {
        try {
          await new CouponAmqpPublisher(
            (await transport()).channel,
          ).publishConfirmed(result);
        } catch {
          throw new Error('PUBLISH_NOT_CONFIRMED');
        }
      },
    },
    onModuleDestroy: async () => {
      closed = true;
      const pending = opening;
      opening = undefined;
      const active = await pending?.catch(() => undefined);
      await active?.connection.close().catch(() => undefined);
      await pool.end();
    },
  };
}

export const couponProviders: Provider[] = [
  {
    provide: COUPON_RESOURCES,
    inject: [PromotionsConfigService],
    useFactory: nativeCouponResources,
  },
  {
    provide: COUPON_EVIDENCE_PROVIDER,
    useValue: {
      verify: async () => {
        throw new Error('COUPON_EVIDENCE_UNAVAILABLE');
      },
    } satisfies CouponEvidenceProvider,
  },
  {
    provide: CouponCommandProcessor,
    inject: [COUPON_RESOURCES, COUPON_EVIDENCE_PROVIDER],
    useFactory: (
      resources: CouponResources,
      evidence: CouponEvidenceProvider,
    ) => new CouponCommandProcessor(resources.pool, evidence),
  },
  {
    provide: CouponOutbox,
    inject: [COUPON_RESOURCES],
    useFactory: (resources: CouponResources) =>
      new CouponOutbox(resources.pool, resources.publisher),
  },
  {
    provide: CouponCommandDeliveryHandler,
    inject: [CouponCommandProcessor],
    useFactory: (processor: CouponCommandProcessor) =>
      new CouponCommandDeliveryHandler(processor),
  },
];
