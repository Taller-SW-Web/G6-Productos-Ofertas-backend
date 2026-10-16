import {
  Injectable,
  ServiceUnavailableException,
  type OnModuleDestroy,
} from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { checkServerIdentity } from 'node:tls';
import pg, { type PoolConfig } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';

export function readDatabaseConfig(
  env: Readonly<NodeJS.ProcessEnv>,
): PoolConfig {
  try {
    for (const key of [
      'PGHOST',
      'PGPORT',
      'PGDATABASE',
      'PGUSER',
      'PGPASSWORD',
      'PGSSLMODE',
      'PGSSLROOTCERT',
      'G6_DATABASE_SCHEMA',
      'G6_EXPECTED_ROLE',
      'G6_CONNECTION_MODE',
    ]) {
      if (!env[key]?.trim()) throw new Error();
    }
    if (
      env.G6_DATABASE_SCHEMA !== 'catalog' ||
      env.PGSSLMODE !== 'verify-full' ||
      !['catalog_dev_login', 'catalog_app'].includes(env.G6_EXPECTED_ROLE!) ||
      env.PGUSER!.split('.')[0] !== env.G6_EXPECTED_ROLE ||
      !['session', 'direct'].includes(env.G6_CONNECTION_MODE!) ||
      !/^\d+$/.test(env.PGPORT!) ||
      +env.PGPORT! < 1 ||
      +env.PGPORT! > 65535 ||
      !isAbsolute(env.PGSSLROOTCERT!)
    )
      throw new Error();
    const ca = readFileSync(env.PGSSLROOTCERT!, 'utf8');
    if (!ca.includes('-----BEGIN CERTIFICATE-----')) throw new Error();
    return {
      host: env.G6_CONNECT_HOST || env.PGHOST,
      port: Number(env.PGPORT),
      database: env.PGDATABASE,
      user: env.PGUSER,
      password: env.PGPASSWORD,
      ssl: {
        ca,
        rejectUnauthorized: true,
        servername: env.PGHOST,
        checkServerIdentity: (_host, certificate) =>
          checkServerIdentity(env.PGHOST!, certificate),
      },
      max: 4,
      connectionTimeoutMillis: 10000,
      idleTimeoutMillis: 10000,
      query_timeout: 10000,
      statement_timeout: 10000,
    };
  } catch {
    throw new Error('Configuración PostgreSQL catalog inválida');
  }
}

@Injectable()
export class Database implements OnModuleDestroy {
  private pool?: pg.Pool;
  private db?: NodePgDatabase;
  private closed = false;

  async read<T>(query: (db: NodePgDatabase) => Promise<T>): Promise<T> {
    try {
      if (this.closed) throw new Error();
      if (!this.pool) {
        this.pool = new pg.Pool(readDatabaseConfig(process.env));
        // pg emite errores de clientes idle fuera de la promesa de consulta.
        // Nunca emitir el error del driver, SQL, parámetros ni configuración.
        this.pool.on('error', () => {
          this.db = undefined;
          process.stderr.write(
            JSON.stringify({
              service: 'catalog-svc',
              code: 'DATABASE_IDLE_FAILURE',
            }) + '\n',
          );
        });
      }
      this.db ??= drizzle(this.pool);
      return await query(this.db);
    } catch {
      throw new ServiceUnavailableException(
        'Servicio temporalmente no disponible',
      );
    }
  }

  async verifyIdentity(): Promise<void> {
    await this.read(async (db) => {
      const result = await db.execute(sql`SELECT current_user AS role,
        current_database() AS database, r.rolsuper, r.rolbypassrls,
        r.rolcreaterole, r.rolcreatedb,
        has_schema_privilege(current_user, ${'catalog'}, 'USAGE') AS usage,
        EXISTS (SELECT 1 FROM pg_namespace n WHERE n.nspname = ${'catalog'}
          AND pg_has_role(current_user, n.nspowner, 'MEMBER')) AS owner_member
        FROM pg_roles r WHERE r.rolname = current_user`);
      const row = result.rows[0];
      if (
        !row ||
        row.role !== process.env.G6_EXPECTED_ROLE ||
        row.database !== process.env.PGDATABASE ||
        row.rolsuper ||
        row.rolbypassrls ||
        row.rolcreaterole ||
        row.rolcreatedb ||
        !row.usage ||
        row.owner_member
      ) {
        throw new Error();
      }
    });
  }

  async onModuleDestroy(): Promise<void> {
    this.closed = true;
    await this.pool?.end();
  }
}
