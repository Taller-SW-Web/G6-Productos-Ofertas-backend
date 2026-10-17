import { Inject, Injectable } from '@nestjs/common';
import { and, asc, count, eq, isNull } from 'drizzle-orm';
import {
  PricingDatabase,
  type PricingTransaction,
} from './pricing.database.js';
import {
  prices,
  priceValidities,
  scheduledPrices,
  bulkPriceJobs,
  bulkPriceRows,
} from './pricing.schema.js';
import { rethrowPersistenceError } from './persistence.error.js';

@Injectable()
export class PricingRepository {
  constructor(
    @Inject(PricingDatabase) private readonly database: PricingDatabase,
  ) {}

  // El caller construye snapshot + Outbox/Inbox en el mismo tx; no publicar aquí.
  async transaction<T>(
    operation: (tx: PricingTransaction) => Promise<T>,
    config?: { isolationLevel: 'repeatable read'; accessMode: 'read only' },
  ): Promise<T> {
    let callbackFailure: { error: unknown } | undefined;
    try {
      return await this.database.db.transaction(async (tx) => {
        try {
          return await operation(tx);
        } catch (error) {
          callbackFailure = { error };
          throw error;
        }
      }, config);
    } catch (error) {
      rethrowPersistenceError(
        error,
        callbackFailure?.error === error && callbackFailure !== undefined,
      );
    }
  }

  async findDefinition(
    target:
      { productId: string; sku?: never } | { sku: string; productId?: never },
    channelId: string | null,
  ) {
    const [price] = await this.execute(() =>
      this.database.db
        .select()
        .from(prices)
        .where(
          and(
            target.productId !== undefined
              ? eq(prices.productId, target.productId)
              : eq(prices.sku, target.sku),
            channelId === null
              ? isNull(prices.channelId)
              : eq(prices.channelId, channelId),
          ),
        ),
    );
    return price;
  }

  findValidities(priceId: string) {
    return this.execute(() =>
      this.database.db
        .select()
        .from(priceValidities)
        .where(eq(priceValidities.priceId, priceId))
        .orderBy(asc(priceValidities.validFrom)),
    );
  }

  // Una fotografía consistente para que el resolver no mezcle dos commits.
  readProduct(productId: string) {
    return this.transaction(
      async (tx) => {
        const [definition] = await tx
          .select()
          .from(prices)
          .where(
            and(eq(prices.productId, productId), isNull(prices.channelId)),
          );
        if (!definition) return undefined;
        const validities = await tx
          .select()
          .from(priceValidities)
          .where(eq(priceValidities.priceId, definition.id))
          .orderBy(asc(priceValidities.validFrom));
        return { definition, validities };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }

  readSchedules(
    target: { productId: string } | { sku: string },
    pagina: number,
    tamanio: number,
  ) {
    return this.transaction(
      async (tx) => {
        const scope =
          'productId' in target
            ? eq(prices.productId, target.productId)
            : eq(prices.sku, target.sku);
        const [total] = await tx
          .select({ value: count() })
          .from(scheduledPrices)
          .innerJoin(prices, eq(prices.id, scheduledPrices.priceId))
          .where(scope);
        const items = await tx
          .select({
            schedule: scheduledPrices,
            validity: priceValidities,
            definition: prices,
          })
          .from(scheduledPrices)
          .innerJoin(prices, eq(prices.id, scheduledPrices.priceId))
          .innerJoin(
            priceValidities,
            eq(priceValidities.id, scheduledPrices.validityId),
          )
          .where(scope)
          .orderBy(asc(priceValidities.validFrom), asc(scheduledPrices.id))
          .limit(tamanio)
          .offset((pagina - 1) * tamanio);
        return { total: total.value, items };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }

  readImport(batchId: string) {
    return this.transaction(
      async (tx) => {
        const [job] = await tx
          .select()
          .from(bulkPriceJobs)
          .where(eq(bulkPriceJobs.id, batchId));
        if (!job) return undefined;
        const rows = await tx
          .select()
          .from(bulkPriceRows)
          .where(eq(bulkPriceRows.batchId, batchId))
          .orderBy(asc(bulkPriceRows.rowId));
        return { job, rows };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }

  private async execute<T>(operation: () => PromiseLike<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      rethrowPersistenceError(error);
    }
  }
}
