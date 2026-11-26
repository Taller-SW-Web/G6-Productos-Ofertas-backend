import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { PRICING_CONFIG, type PricingConfig } from '../config/environment.js';
import { PricingRepository } from '../persistence/pricing.repository.js';
import {
  inbox,
  prices,
  priceValidities,
} from '../persistence/pricing.schema.js';
import { insertPricingFacts } from './service-bus-deliveries.js';

const HANDLER = 'pricing.bulk.price.apply.v1';
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MONEY_RE = /^\d{1,10}(?:\.\d{2})$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isObject(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

export interface BulkPriceApplyOutcome {
  status: 'APPLIED' | 'PARTIAL' | 'REJECTED' | 'DUPLICATE';
  resultEventName?:
    | 'pricing.bulk.price.apply.completed'
    | 'pricing.bulk.price.apply.rejected';
}

@Injectable()
export class BulkPriceApplyService {
  constructor(
    @Inject(PricingRepository) private readonly repository: PricingRepository,
    @Inject(PRICING_CONFIG) private readonly config: PricingConfig,
  ) {}

  async process(
    message: Record<string, unknown>,
  ): Promise<BulkPriceApplyOutcome> {
    if (
      typeof message.message_id !== 'string' ||
      !UUID_RE.test(message.message_id) ||
      typeof message.operation_id !== 'string' ||
      !UUID_RE.test(message.operation_id) ||
      typeof message.correlation_id !== 'string' ||
      !message.correlation_id ||
      message.producer !== 'bulk-svc' ||
      message.kind !== 'command' ||
      message.name !== 'pricing.bulk.price.apply.requested' ||
      !isObject(message.data)
    ) {
      throw new Error('PRICING_INVALID_BULK_ENVELOPE');
    }

    const messageId = message.message_id;
    const operationId = message.operation_id;
    const correlationId = message.correlation_id;
    const data = message.data;
    const serviceBusEnabled = Boolean(this.config.serviceBus);

    return this.repository.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${operationId}, 0))`,
      );
      const [existing] = await tx
        .select()
        .from(inbox)
        .where(and(eq(inbox.messageId, messageId), eq(inbox.handler, HANDLER)))
        .limit(1);

      if (existing) {
        if (canonical(existing.payload) !== canonical(message)) {
          throw new Error('PRICING_MESSAGE_ID_CONFLICT');
        }
        return { status: 'DUPLICATE' };
      }

      const priorOperations = await tx
        .select({ payload: inbox.payload })
        .from(inbox)
        .where(
          and(
            eq(inbox.handler, HANDLER),
            sql`${inbox.payload}->>'operation_id' = ${operationId}`,
          ),
        );
      if (priorOperations.length > 0) {
        const sameIntent = priorOperations.some((row) => {
          const prior = isObject(row.payload) ? row.payload : {};
          return canonical(prior.data) === canonical(data);
        });
        await tx
          .insert(inbox)
          .values({
            messageId,
            handler: HANDLER,
            eventName: 'pricing.bulk.price.apply.requested',
            correlationId,
            payload: message,
            result: sameIntent ? 'DUPLICATE_OPERATION' : 'OPERATION_ID_CONFLICT',
          })
          .onConflictDoNothing();
        if (!sameIntent) {
          await insertPricingFacts(
            tx,
            [
              {
                messageId: randomUUID(),
                schemaVersion: 1,
                occurredAt: new Date(),
                correlationId,
                causationId: messageId,
                operationId,
                kind: 'result',
                eventName: 'pricing.bulk.price.apply.rejected',
                payload: {
                  batch_id: data.batch_id ?? null,
                  batch_operation_id: data.batch_operation_id ?? null,
                  code: 'IDEMPOTENCY_CONFLICT',
                  results: [],
                },
              },
            ],
            serviceBusEnabled,
          );
          return {
            status: 'REJECTED',
            resultEventName: 'pricing.bulk.price.apply.rejected',
          };
        }
        return { status: 'DUPLICATE' };
      }

      const items = Array.isArray(data.items) ? data.items : [];
      const rowResults: Array<Record<string, unknown>> = [];
      let appliedCount = 0;

      for (let i = 0; i < items.length; i += 1) {
        const item = items[i];
        if (
          !isObject(item) ||
          typeof item.sku !== 'string' ||
          !item.sku.trim() ||
          typeof item.precio_regular !== 'string' ||
          !MONEY_RE.test(item.precio_regular) ||
          (item.precio_oferta !== undefined &&
            item.precio_oferta !== null &&
            (typeof item.precio_oferta !== 'string' ||
              !MONEY_RE.test(item.precio_oferta))) ||
          typeof item.currency !== 'string' ||
          !/^[A-Z]{3}$/.test(item.currency)
        ) {
          rowResults.push({
            row_number: isObject(item) ? (item.row_number ?? i + 2) : i + 2,
            row_operation_id: isObject(item)
              ? (item.row_operation_id ?? null)
              : null,
            sku: isObject(item) ? (item.sku ?? null) : null,
            status: 'REJECTED',
            code: 'VALIDACION',
          });
          continue;
        }

        const sku = item.sku.trim();
        const channelId =
          typeof item.channel_id === 'string' && item.channel_id.trim()
            ? item.channel_id.trim()
            : null;
        const [priceRow] = await tx
          .insert(prices)
          .values({
            sku,
            channelId,
            priceVersion: 1n,
          })
          .onConflictDoUpdate({
            target: [prices.productId, prices.sku, prices.channelId],
            set: {
              priceVersion: sql`${prices.priceVersion} + 1`,
              updatedAt: sql`now()`,
            },
          })
          .returning({ id: prices.id, priceVersion: prices.priceVersion });

        await tx
          .update(priceValidities)
          .set({ isCancelled: true, updatedAt: sql`now()` })
          .where(
            and(
              eq(priceValidities.priceId, priceRow.id),
              eq(priceValidities.isCancelled, false),
            ),
          );

        await tx.insert(priceValidities).values({
          priceId: priceRow.id,
          priceVersion: priceRow.priceVersion,
          precioRegular: item.precio_regular,
          precioOferta:
            typeof item.precio_oferta === 'string' ? item.precio_oferta : null,
          currency: item.currency,
          validFrom: new Date(),
          motivoCambio: 'BULK_PRICE_APPLY',
          isCancelled: false,
        });

        appliedCount += 1;
        rowResults.push({
          row_number: item.row_number ?? i + 2,
          row_operation_id: item.row_operation_id ?? randomUUID(),
          sku,
          status: 'COMPLETED',
          code: null,
          price_version: Number(priceRow.priceVersion),
        });
      }

      const allRejected = items.length === 0 || appliedCount === 0;
      const resultEventName = allRejected
        ? 'pricing.bulk.price.apply.rejected'
        : 'pricing.bulk.price.apply.completed';

      await tx.insert(inbox).values({
        messageId,
        handler: HANDLER,
        eventName: 'pricing.bulk.price.apply.requested',
        correlationId,
        payload: message,
        result: allRejected
          ? 'REJECTED'
          : appliedCount === items.length
            ? 'APPLIED'
            : 'PARTIAL',
      });

      await insertPricingFacts(
        tx,
        [
          {
            messageId: randomUUID(),
            schemaVersion: 1,
            occurredAt: new Date(),
            correlationId,
            causationId: messageId,
            operationId,
            kind: 'result',
            eventName: resultEventName,
            payload: {
              batch_id: data.batch_id ?? null,
              batch_operation_id: data.batch_operation_id ?? null,
              applied_count: appliedCount,
              total_count: items.length,
              results: rowResults,
            },
          },
        ],
        serviceBusEnabled,
      );

      return {
        status: allRejected
          ? 'REJECTED'
          : appliedCount === items.length
            ? 'APPLIED'
            : 'PARTIAL',
        resultEventName,
      };
    });
  }
}
