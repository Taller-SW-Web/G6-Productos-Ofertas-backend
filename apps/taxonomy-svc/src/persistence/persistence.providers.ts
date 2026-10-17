import type { Provider } from '@nestjs/common';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { TAXONOMY_REPOSITORY } from '../taxonomy.repository.js';
import { UnconfiguredTaxonomyRepository } from '../unconfigured-taxonomy.repository.js';
import { DrizzleTaxonomyRepository } from './drizzle-taxonomy.repository.js';
import { esquemaTaxonomia } from './taxonomy.schema.js';
import { Database } from '../database.js';
import { PostgresTaxonomyRepository } from '../postgres-taxonomy.repository.js';

export function crearRepositorioDrizzle(
  databaseUrl: string,
): DrizzleTaxonomyRepository {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'crearRepositorioDrizzle no está permitido en runtime productivo; use iniciarTaxonomySvc con Database y las garantías obligatorias de TLS e identidad.',
    );
  }
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
  if (url) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'El repositorio Drizzle basado en databaseUrl no está permitido en runtime productivo; use iniciarTaxonomySvc con Database y las garantías obligatorias de TLS e identidad.',
      );
    }
    return {
      provide: TAXONOMY_REPOSITORY,
      useFactory: () => crearRepositorioDrizzle(url),
    };
  }
  return {
    provide: TAXONOMY_REPOSITORY,
    useFactory: (db: Database) => {
      if (process.env.PGHOST?.trim() || process.env.DATABASE_URL?.trim()) {
        return new PostgresTaxonomyRepository(db);
      }
      return new UnconfiguredTaxonomyRepository();
    },
    inject: [Database],
  };
}
