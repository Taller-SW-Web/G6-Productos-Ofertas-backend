import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

export type Environment = 'development' | 'test' | 'production';
export type DatabaseConfig =
  | Readonly<{ mode: 'url'; connectionString: string }>
  | Readonly<{
      mode: 'session';
      host: string;
      port: number;
      database: string;
      user: string;
      password: string;
      ca: string;
    }>;

function readDatabase(
  env: Record<string, string | undefined>,
  errors: string[],
): DatabaseConfig {
  const pgKeys = [
    'PGHOST',
    'PGPORT',
    'PGDATABASE',
    'PGUSER',
    'PGPASSWORD',
    'PGSSLMODE',
    'PGSSLROOTCERT',
  ];
  if (
    pgKeys.some((key) => env[key] !== undefined) ||
    env.G6_CONNECTION_MODE !== undefined
  ) {
    for (const key of pgKeys) {
      if (!env[key]?.trim())
        errors.push(key + ' es obligatorio para Session Pooler.');
    }
    if (env.PGHOST && !/^[A-Za-z0-9.-]+$/.test(env.PGHOST))
      errors.push('PGHOST debe ser un host valido.');
    const port = Number(env.PGPORT);
    if (!/^\d+$/.test(env.PGPORT ?? '') || port < 1 || port > 65535)
      errors.push('PGPORT debe ser un entero entre 1 y 65535.');
    if (env.PGSSLMODE !== 'verify-full')
      errors.push('PGSSLMODE debe ser verify-full.');
    if (env.G6_CONNECTION_MODE !== 'session')
      errors.push('G6_CONNECTION_MODE debe ser session.');
    if (env.G6_DATABASE_SCHEMA !== 'catalog')
      errors.push('G6_DATABASE_SCHEMA debe ser catalog.');
    let ca = '';
    try {
      if (!env.PGSSLROOTCERT || !isAbsolute(env.PGSSLROOTCERT))
        throw new Error();
      ca = readFileSync(env.PGSSLROOTCERT, 'utf8');
      if (!ca.trim()) throw new Error();
    } catch {
      errors.push(
        'PGSSLROOTCERT debe apuntar a un certificado absoluto, existente y legible.',
      );
    }
    return Object.freeze({
      mode: 'session',
      host: env.PGHOST ?? '',
      port,
      database: env.PGDATABASE ?? '',
      user: env.PGUSER ?? '',
      password: env.PGPASSWORD ?? '',
      ca,
    });
  }
  const connectionString = env.DATABASE_URL ?? '';
  try {
    const url = new URL(connectionString);
    if (
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      !url.hostname ||
      url.pathname.length < 2 ||
      (url.port && (Number(url.port) < 1 || Number(url.port) > 65535)) ||
      /\s/.test(connectionString)
    )
      throw new Error();
  } catch {
    errors.push(
      'DATABASE_URL debe ser una URL PostgreSQL con host y base, o configurar las variables PG del servicio.',
    );
  }
  return Object.freeze({ mode: 'url', connectionString });
}

export class CatalogConfig {
  readonly environment: Environment;
  readonly port: number;
  readonly database: DatabaseConfig;

  constructor(env: Record<string, string | undefined>) {
    const errors: string[] = [];
    const environment = env.NODE_ENV;
    if (!['development', 'test', 'production'].includes(environment ?? '')) {
      errors.push('NODE_ENV debe ser development, test o production.');
    }
    const rawPort = env.CATALOG_SVC_PORT ?? env.PORT ?? '';
    const port = Number(rawPort);
    if (!/^\d+$/.test(rawPort) || port < 1 || port > 65535) {
      errors.push(
        'CATALOG_SVC_PORT (o PORT) debe ser un entero entre 1 y 65535.',
      );
    }
    const database = readDatabase(env, errors);
    if (errors.length) {
      throw new Error(
        'Configuracion de catalog-svc invalida: ' + errors.join(' '),
      );
    }
    this.environment = environment as Environment;
    this.port = port;
    this.database = database;
    Object.freeze(this);
  }
}
