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
import { esquemaTaxonomia } from './persistence/taxonomy.schema.js';
import type { TransaccionTaxonomy } from './persistence/drizzle-taxonomy.repository.js';
import type { TaxonomyWriteUnitOfWork } from './persistence/taxonomy-write.unit-of-work.js';

export function parseDatabaseUrl(
  urlStr: string,
): Partial<Record<string, string>> {
  try {
    const url = new URL(urlStr);
    const result: Partial<Record<string, string>> = {};
    if (url.hostname) result.PGHOST = url.hostname;
    if (url.port) result.PGPORT = url.port;
    const dbName = url.pathname.replace(/^\//, '');
    if (dbName) result.PGDATABASE = dbName;
    if (url.username) result.PGUSER = decodeURIComponent(url.username);
    if (url.password) result.PGPASSWORD = decodeURIComponent(url.password);
    const sslmode = url.searchParams.get('sslmode');
    if (sslmode) result.PGSSLMODE = sslmode;
    const sslrootcert = url.searchParams.get('sslrootcert');
    if (sslrootcert) result.PGSSLROOTCERT = sslrootcert;
    const schema =
      url.searchParams.get('currentSchema') ||
      url.searchParams.get('search_path');
    if (schema) result.G6_DATABASE_SCHEMA = schema;
    return result;
  } catch {
    return {};
  }
}

export function readDatabaseConfig(
  env: Readonly<NodeJS.ProcessEnv>,
): PoolConfig {
  try {
    const urlParams = env.DATABASE_URL?.trim()
      ? parseDatabaseUrl(env.DATABASE_URL)
      : {};
    const effectiveEnv: NodeJS.ProcessEnv = {
      ...env,
      ...urlParams,
    };
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
      if (!effectiveEnv[key]?.trim()) throw new Error();
    }
    if (
      effectiveEnv.G6_DATABASE_SCHEMA !== 'taxonomy' ||
      effectiveEnv.PGSSLMODE !== 'verify-full' ||
      !['taxonomy_dev_login', 'taxonomy_app'].includes(
        effectiveEnv.G6_EXPECTED_ROLE!,
      ) ||
      effectiveEnv.PGUSER!.split('.')[0] !== effectiveEnv.G6_EXPECTED_ROLE ||
      !['session', 'direct'].includes(effectiveEnv.G6_CONNECTION_MODE!) ||
      !/^\d+$/.test(effectiveEnv.PGPORT!) ||
      +effectiveEnv.PGPORT! < 1 ||
      +effectiveEnv.PGPORT! > 65535 ||
      !isAbsolute(effectiveEnv.PGSSLROOTCERT!)
    )
      throw new Error();
    const ca = readFileSync(effectiveEnv.PGSSLROOTCERT!, 'utf8');
    if (!ca.includes('-----BEGIN CERTIFICATE-----')) throw new Error();
    return {
      host: effectiveEnv.G6_CONNECT_HOST || effectiveEnv.PGHOST,
      port: Number(effectiveEnv.PGPORT),
      database: effectiveEnv.PGDATABASE,
      user: effectiveEnv.PGUSER,
      password: effectiveEnv.PGPASSWORD,
      ssl: {
        ca,
        rejectUnauthorized: true,
        servername: effectiveEnv.PGHOST,
        checkServerIdentity: (_host, certificate) =>
          checkServerIdentity(effectiveEnv.PGHOST!, certificate),
      },
      max: 4,
      connectionTimeoutMillis: 10000,
      idleTimeoutMillis: 10000,
      query_timeout: 10000,
      statement_timeout: 10000,
    };
  } catch {
    throw new Error('Configuración PostgreSQL taxonomy inválida');
  }
}

const CODIGOS_ERROR_CONEXION = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'EPIPE',
  '08000',
  '08001',
  '08003',
  '08004',
  '08006',
  '08007',
  '57P01',
  '57P02',
  '57P03',
]);

function esErrorDeConexion(error: unknown, profundidad = 0): boolean {
  if (typeof error !== 'object' || error === null || profundidad > 3) {
    return false;
  }
  const dato = error as { code?: unknown; cause?: unknown };
  if (typeof dato.code === 'string' && CODIGOS_ERROR_CONEXION.has(dato.code)) {
    return true;
  }
  return dato.cause ? esErrorDeConexion(dato.cause, profundidad + 1) : false;
}

@Injectable()
export class Database implements OnModuleDestroy, TaxonomyWriteUnitOfWork {
  private pool?: pg.Pool;
  private db?: NodePgDatabase;
  private closed = false;

  async read<T>(query: (db: NodePgDatabase) => Promise<T>): Promise<T> {
    try {
      if (this.closed) throw new Error('Database cerrada');
      this.db ??= drizzle(this.obtenerPool());
      return await query(this.db);
    } catch {
      throw new ServiceUnavailableException(
        'Servicio temporalmente no disponible',
      );
    }
  }

  async enTransaccion<T>(
    operacion: (tx: TransaccionTaxonomy) => Promise<T>,
  ): Promise<T> {
    if (this.closed) {
      throw new ServiceUnavailableException(
        'Servicio temporalmente no disponible',
      );
    }
    try {
      const db = drizzle(this.obtenerPool(), { schema: esquemaTaxonomia });
      return await db.transaction((tx) => operacion(tx));
    } catch (error) {
      if (esErrorDeConexion(error)) {
        throw new ServiceUnavailableException(
          'Servicio temporalmente no disponible',
        );
      }
      throw error;
    }
  }

  async verifyIdentity(
    env: Readonly<NodeJS.ProcessEnv> = process.env,
  ): Promise<void> {
    const urlParams = env.DATABASE_URL?.trim()
      ? parseDatabaseUrl(env.DATABASE_URL)
      : {};
    const effectiveEnv: NodeJS.ProcessEnv = {
      ...env,
      ...urlParams,
    };
    await this.read(async (db) => {
      const result = await db.execute(sql`SELECT current_user AS role,
        current_database() AS database, r.rolsuper, r.rolbypassrls,
        r.rolcreaterole, r.rolcreatedb,
        has_schema_privilege(current_user, ${'taxonomy'}, 'USAGE') AS usage,
        EXISTS (SELECT 1 FROM pg_namespace n WHERE n.nspname = ${'taxonomy'}
          AND pg_has_role(current_user, n.nspowner, 'MEMBER')) AS owner_member
        FROM pg_roles r WHERE r.rolname = current_user`);
      const row = result.rows[0];
      if (
        !row ||
        row.role !== effectiveEnv.G6_EXPECTED_ROLE ||
        row.database !== effectiveEnv.PGDATABASE ||
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

  private obtenerPool(): pg.Pool {
    if (this.closed) throw new Error('Database cerrada');
    if (!this.pool) {
      this.pool = new pg.Pool(readDatabaseConfig(process.env));
      // pg emite errores de clientes idle fuera de la promesa de consulta.
      // Nunca emitir el error del driver, SQL, parámetros ni configuración.
      this.pool.on('error', () => {
        this.db = undefined;
        process.stderr.write(
          JSON.stringify({
            service: 'taxonomy-svc',
            code: 'DATABASE_IDLE_FAILURE',
          }) + '\n',
        );
      });
    }
    return this.pool;
  }
}
