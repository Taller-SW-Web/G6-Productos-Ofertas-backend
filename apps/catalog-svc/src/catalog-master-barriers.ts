import { ServiceUnavailableException } from '@nestjs/common';
import { and, eq, or, sql } from 'drizzle-orm';
import type { CatalogTransaction } from './database.js';
import { masterBarriers } from './catalog.schema.js';

export const masterTypes = [
  'CATEGORY',
  'BRAND',
  'PRODUCT_TYPE',
  'CHARACTERISTIC_VALUE',
  'PRODUCT_TYPE_CHARACTERISTIC',
] as const;
export type MasterType = (typeof masterTypes)[number];
export interface MasterReference {
  type: MasterType;
  id: string;
}

/** Shared by writes and barrier installation. Opaque IDs are never parsed. */
export async function lockMasterReferences(
  tx: CatalogTransaction,
  refs: readonly MasterReference[],
) {
  if (refs.some((r) => r.type === 'PRODUCT_TYPE_CHARACTERISTIC'))
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended('catalog-master-association-gate',0))`,
    );
  else
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock_shared(hashtextextended('catalog-master-association-gate',0))`,
    );
  const keys = [
    ...new Set(refs.map((r) => JSON.stringify([r.type, r.id]))),
  ].sort();
  for (const key of keys)
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${'catalog-master:' + key},0))`,
    );
}
export function masterReferences(
  product: { categoria_id: string; marca_id: string; tipo_producto_id: string },
  values: readonly { valor_id: string | null }[],
): MasterReference[] {
  return [
    { type: 'CATEGORY', id: product.categoria_id },
    { type: 'BRAND', id: product.marca_id },
    { type: 'PRODUCT_TYPE', id: product.tipo_producto_id },
    ...values
      .filter((v) => v.valor_id !== null)
      .map((v) => ({ type: 'CHARACTERISTIC_VALUE' as const, id: v.valor_id! })),
  ];
}
export async function assertMasterReferences(
  tx: CatalogTransaction,
  refs: readonly MasterReference[],
) {
  if (!refs.length) return;
  await lockMasterReferences(tx, refs);
  const predicates = refs.map((r) =>
    and(
      eq(masterBarriers.master_type, r.type),
      eq(masterBarriers.master_id, r.id),
    ),
  );
  // Association identity has no approved reverse mapping. Until ratified, new
  // dependencies fail closed while such an unresolved barrier exists. Independent
  // edits and removals do not call this check with new references.
  const [blocked] = await tx
    .select({ id: masterBarriers.id })
    .from(masterBarriers)
    .where(
      and(
        eq(masterBarriers.is_blocking, true),
        or(
          ...predicates,
          eq(masterBarriers.master_type, 'PRODUCT_TYPE_CHARACTERISTIC'),
        ),
      ),
    )
    .limit(1);
  if (blocked) throw new ServiceUnavailableException();
}

/** No row locks here: writers lock their aggregate before these advisory locks. */
export async function hasActiveMasterUse(
  tx: CatalogTransaction,
  type: MasterType,
  id: string,
): Promise<boolean> {
  let query;
  if (type === 'CATEGORY')
    query = sql`SELECT 1 FROM catalog.products WHERE estado='ACTIVO' AND categoria_id=${id} LIMIT 1`;
  else if (type === 'BRAND')
    query = sql`SELECT 1 FROM catalog.products WHERE estado='ACTIVO' AND marca_id=${id} LIMIT 1`;
  else if (type === 'PRODUCT_TYPE')
    query = sql`SELECT 1 FROM catalog.products WHERE estado='ACTIVO' AND tipo_producto_id=${id} LIMIT 1`;
  else if (type === 'CHARACTERISTIC_VALUE')
    query = sql`SELECT 1 WHERE EXISTS (
      SELECT 1 FROM catalog.product_attribute_values a JOIN catalog.products p ON p.id=a.product_id
      WHERE p.estado='ACTIVO' AND a.valor_id=${id}
    ) OR EXISTS (
      SELECT 1 FROM catalog.variant_attribute_values a JOIN catalog.variants v ON v.id=a.variant_id
      WHERE v.estado='ACTIVA' AND a.valor_id=${id}
    ) OR EXISTS (
      SELECT 1 FROM catalog.variants v CROSS JOIN LATERAL jsonb_each(v.identifying_key) k
      WHERE v.estado='ACTIVA' AND k.value->>'valor_id'=${id}
    )`;
  else throw new ServiceUnavailableException();
  return (await tx.execute(query)).rows.length > 0;
}
