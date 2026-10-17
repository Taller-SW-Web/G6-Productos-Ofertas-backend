import {
  Injectable,
  Inject,
  Optional,
  ServiceUnavailableException,
  type OnModuleDestroy,
} from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { isIP } from 'node:net';
import { checkServerIdentity } from 'node:tls';
import pg, { type PoolConfig } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';

export const CATALOG_POSTGRES_CONFIG = Symbol('CATALOG_POSTGRES_CONFIG');

export interface PostgresSettings {
  readonly pool: Readonly<PoolConfig>;
  readonly expectedRole: string;
  readonly database: string;
  readonly user: string;
  readonly password: string;
  readonly mode: 'session' | 'direct';
}

function validHost(value: string): boolean {
  return (
    isIP(value) !== 0 ||
    /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(value)
  );
}

export function readDatabaseConfig(
  env: Readonly<NodeJS.ProcessEnv>,
): PoolConfig {
  const errors: string[] = [];
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
      if (!env[key]?.trim()) errors.push(key);
    }
    if (errors.length) throw new Error();
    if (!validHost(env.PGHOST!)) errors.push('PGHOST');
    if (env.G6_CONNECT_HOST && !validHost(env.G6_CONNECT_HOST))
      errors.push('G6_CONNECT_HOST');
    if (env.G6_DATABASE_SCHEMA !== 'catalog') errors.push('G6_DATABASE_SCHEMA');
    if (env.PGSSLMODE !== 'verify-full') errors.push('PGSSLMODE');
    if (!['catalog_dev_login', 'catalog_app'].includes(env.G6_EXPECTED_ROLE!))
      errors.push('G6_EXPECTED_ROLE');
    if (
      env.PGUSER!.split('.')[0] !== env.G6_EXPECTED_ROLE ||
      (env.G6_CONNECTION_MODE === 'direct' &&
        env.PGUSER !== env.G6_EXPECTED_ROLE)
    )
      errors.push('PGUSER');
    if (!['session', 'direct'].includes(env.G6_CONNECTION_MODE!))
      errors.push('G6_CONNECTION_MODE');
    if (!/^\d+$/.test(env.PGPORT!) || +env.PGPORT! < 1 || +env.PGPORT! > 65535)
      errors.push('PGPORT');
    if (!isAbsolute(env.PGSSLROOTCERT!)) errors.push('PGSSLROOTCERT');
    if (errors.length) throw new Error();
    let ca: string;
    try {
      ca = readFileSync(env.PGSSLROOTCERT!, 'utf8');
    } catch {
      errors.push('PGSSLROOTCERT');
      throw new Error();
    }
    if (!ca.includes('-----BEGIN CERTIFICATE-----')) {
      errors.push('PGSSLROOTCERT');
      throw new Error();
    }
    const hostname = env.PGHOST!;
    return {
      host: env.G6_CONNECT_HOST || env.PGHOST,
      port: Number(env.PGPORT),
      database: env.PGDATABASE,
      user: env.PGUSER,
      password: env.PGPASSWORD,
      ssl: {
        ca,
        rejectUnauthorized: true,
        servername: hostname,
        checkServerIdentity: (_host, certificate) =>
          checkServerIdentity(hostname, certificate),
      },
      max: 4,
      connectionTimeoutMillis: 10000,
      idleTimeoutMillis: 10000,
      query_timeout: 10000,
      statement_timeout: 10000,
    };
  } catch {
    throw new Error(
      'Configuración PostgreSQL catalog inválida: ' + errors.join(', '),
    );
  }
}

export function readPostgresSettings(
  env: Readonly<NodeJS.ProcessEnv>,
): PostgresSettings {
  const pool = Object.freeze(readDatabaseConfig(env));
  return Object.freeze({
    pool,
    expectedRole: env.G6_EXPECTED_ROLE!,
    database: env.PGDATABASE!,
    user: env.PGUSER!,
    password: env.PGPASSWORD!,
    mode: env.G6_CONNECTION_MODE as 'session' | 'direct',
  });
}

@Injectable()
export class Database implements OnModuleDestroy {
  private pool?: pg.Pool;
  private db?: NodePgDatabase;
  private closed = false;
  private settings?: PostgresSettings;

  constructor(
    @Optional() @Inject(CATALOG_POSTGRES_CONFIG) settings?: PostgresSettings,
  ) {
    this.settings = settings;
  }

  private getSettings(): PostgresSettings {
    return (this.settings ??= readPostgresSettings(process.env));
  }

  async read<T>(query: (db: NodePgDatabase) => Promise<T>): Promise<T> {
    try {
      if (this.closed) throw new Error();
      if (!this.pool) {
        this.pool = new pg.Pool(this.getSettings().pool);
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
      const settings = this.getSettings();
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
        row.role !== settings.expectedRole ||
        row.database !== settings.database ||
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
