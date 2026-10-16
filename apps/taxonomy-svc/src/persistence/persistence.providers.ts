import type { Provider } from '@nestjs/common';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { TAXONOMY_REPOSITORY } from '../taxonomy.repository.js';
import { UnconfiguredTaxonomyRepository } from '../unconfigured-taxonomy.repository.js';
import { DrizzleTaxonomyRepository } from './drizzle-taxonomy.repository.js';
import { esquemaTaxonomia } from './taxonomy.schema.js';

export function crearRepositorioDrizzle(
  databaseUrl: string,
): DrizzleTaxonomyRepository {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 5,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 10_000,
  });
  const db = drizzle(pool, { schema: esquemaTaxonomia });
  return new DrizzleTaxonomyRepository(db, () => pool.end());
}

export function proveedorDeRepositorio(databaseUrl?: string): Provider {
  const url = databaseUrl?.trim();
  if (!url) {
    return {
      provide: TAXONOMY_REPOSITORY,
      useClass: UnconfiguredTaxonomyRepository,
    };
  }
  return {
    provide: TAXONOMY_REPOSITORY,
    useFactory: () => crearRepositorioDrizzle(url),
  };
}
