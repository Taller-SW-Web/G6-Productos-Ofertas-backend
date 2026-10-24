import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Canal } from './commercial.types.js';
import {
  type CommercialEligibilityPolicy,
  type EligibilitySelection,
} from './commercial-eligibility.js';
import { Database } from './database.js';

interface EligibilityRow {
  product_id: unknown;
  variant_id: unknown;
}

@Injectable()
export class PostgresCommercialEligibility implements CommercialEligibilityPolicy {
  constructor(private readonly database: Database) {}

  async resolve(canal: Canal): Promise<EligibilitySelection> {
    try {
      const result = await this.database.read((db) =>
        db.execute(sql`
          SELECT p.id::text AS product_id, NULL::text AS variant_id
          FROM catalog.sku_channel_eligibility AS eligibility
          JOIN catalog.sku_identity AS identity
            ON identity.sku = eligibility.sku
          JOIN catalog.products AS p
            ON p.id = identity.product_id
          WHERE eligibility.canal = ${canal}
            AND eligibility.enabled = true
            AND identity.product_id IS NOT NULL
            AND p.estado = 'ACTIVO'
            AND p.tiene_variantes = false

          UNION ALL

          SELECT p.id::text AS product_id, v.id::text AS variant_id
          FROM catalog.sku_channel_eligibility AS eligibility
          JOIN catalog.sku_identity AS identity
            ON identity.sku = eligibility.sku
          JOIN catalog.variants AS v
            ON v.id = identity.variant_id
          JOIN catalog.products AS p
            ON p.id = v.product_id
          WHERE eligibility.canal = ${canal}
            AND eligibility.enabled = true
            AND identity.variant_id IS NOT NULL
            AND v.estado = 'ACTIVA'
            AND p.estado = 'ACTIVO'
            AND p.tiene_variantes = true
        `),
      );

      const productIds = new Set<string>();
      const variantIds = new Set<string>();
      for (const row of result.rows as unknown as EligibilityRow[]) {
        if (typeof row.product_id !== 'string') throw new Error();
        productIds.add(row.product_id);
        if (row.variant_id !== null) {
          if (typeof row.variant_id !== 'string') throw new Error();
          variantIds.add(row.variant_id);
        }
      }

      return {
        productIds: [...productIds],
        variantIds: [...variantIds],
      };
    } catch {
      // Includes a missing candidate table and Poma's typed persistence errors.
      // Keep all database failures fail-closed and independent of driver details.
      throw new ServiceUnavailableException(
        'Servicio temporalmente no disponible',
      );
    }
  }
}
