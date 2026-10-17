import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { CatalogTransaction } from './database.js';
import {
  activationChecks,
  inbox,
  masterBarriers,
  outbox,
  productAttributes,
  productIdentifyingCharacteristics,
  productImages,
  products,
  skuIdentity,
  skuPhysicalProfiles,
  variantAttributes,
  variantImages,
  variants,
} from './catalog.schema.js';

/** SQL repository methods for use inside a CatalogTransactionManager boundary. */
@Injectable()
export class PostgresCatalogWriteRepository {
  async insertProduct(
    tx: CatalogTransaction,
    values: typeof products.$inferInsert,
  ) {
    const [row] = await tx.insert(products).values(values).returning();
    return row;
  }

  async insertVariant(
    tx: CatalogTransaction,
    values: typeof variants.$inferInsert,
  ) {
    const [row] = await tx.insert(variants).values(values).returning();
    return row;
  }

  async findSkuIdentity(tx: CatalogTransaction, sku: string) {
    const [row] = await tx
      .select()
      .from(skuIdentity)
      .where(eq(skuIdentity.sku, sku))
      .limit(1);
    return row ?? null;
  }

  async insertProductImage(
    tx: CatalogTransaction,
    values: typeof productImages.$inferInsert,
  ) {
    const [row] = await tx.insert(productImages).values(values).returning();
    return row;
  }

  async insertVariantImage(
    tx: CatalogTransaction,
    values: typeof variantImages.$inferInsert,
  ) {
    const [row] = await tx.insert(variantImages).values(values).returning();
    return row;
  }

  async insertProductAttribute(
    tx: CatalogTransaction,
    values: typeof productAttributes.$inferInsert,
  ) {
    const [row] = await tx.insert(productAttributes).values(values).returning();
    return row;
  }

  async insertVariantAttribute(
    tx: CatalogTransaction,
    values: typeof variantAttributes.$inferInsert,
  ) {
    const [row] = await tx.insert(variantAttributes).values(values).returning();
    return row;
  }

  async insertIdentifyingCharacteristic(
    tx: CatalogTransaction,
    values: typeof productIdentifyingCharacteristics.$inferInsert,
  ) {
    const [row] = await tx
      .insert(productIdentifyingCharacteristics)
      .values(values)
      .returning();
    return row;
  }

  async insertPhysicalProfile(
    tx: CatalogTransaction,
    values: typeof skuPhysicalProfiles.$inferInsert,
  ) {
    const [row] = await tx
      .insert(skuPhysicalProfiles)
      .values(values)
      .returning();
    return row;
  }

  async insertActivationCheck(
    tx: CatalogTransaction,
    values: typeof activationChecks.$inferInsert,
  ) {
    const [row] = await tx.insert(activationChecks).values(values).returning();
    return row;
  }

  async insertMasterBarrier(
    tx: CatalogTransaction,
    values: typeof masterBarriers.$inferInsert,
  ) {
    const [row] = await tx.insert(masterBarriers).values(values).returning();
    return row;
  }

  async insertOutboxMessage(
    tx: CatalogTransaction,
    values: typeof outbox.$inferInsert,
  ) {
    const [row] = await tx.insert(outbox).values(values).returning();
    return row;
  }

  async insertInboxMessage(
    tx: CatalogTransaction,
    values: typeof inbox.$inferInsert,
  ) {
    const [row] = await tx.insert(inbox).values(values).returning();
    return row;
  }
}
