import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, isNull } from 'drizzle-orm';
import {
  PricingDatabase,
  type PricingTransaction,
} from './pricing.database.js';
import { prices, priceValidities } from './pricing.schema.js';
import { rethrowPersistenceError } from './persistence.error.js';

@Injectable()
export class PricingRepository {
  constructor(
    @Inject(PricingDatabase) private readonly database: PricingDatabase,
  ) {}

  // El caller construye snapshot + Outbox/Inbox en el mismo tx; no publicar aquí.
  async transaction<T>(
    operation: (tx: PricingTransaction) => Promise<T>,
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
      });
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

  private async execute<T>(operation: () => PromiseLike<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      rethrowPersistenceError(error);
    }
  }
}
