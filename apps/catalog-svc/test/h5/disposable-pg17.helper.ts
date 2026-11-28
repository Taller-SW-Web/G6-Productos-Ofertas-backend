import { sql } from 'drizzle-orm';
import { Database, type PostgresSettings } from '../../src/database.js';

/**
 * H26 — Mecanismo compartido y seguro para PostgreSQL 17 descartable en suites H5.
 * Valida estrictamente:
 *  - Host local autorizado (127.0.0.1 / localhost)
 *  - Nombre de base dedicado inequivocamente a pruebas aisladas (*_isolated)
 *  - Rol runtime no propietario (catalog_app)
 *  - Version real PostgreSQL 17 (170000 <= server_version_num < 180000)
 *  - Migraciones oficiales aplicadas (products, outbox_delivery, bulk_retry_command_receipts)
 */

const ALLOWED_LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost']);
const ISOLATED_DB_PATTERN = /^h[45]_[a-z0-9_]+_isolated$/;
const EXPECTED_RUNTIME_ROLES = new Set(['catalog_app', 'catalog_dev_login']);

export function readSafeDisposablePg17Settings(
  env: Readonly<NodeJS.ProcessEnv> = process.env,
): PostgresSettings {
  const host = (env.PGHOST || '127.0.0.1').trim();
  const port = Number(env.PGPORT || '55432');
  const database = (env.PGDATABASE || 'h5_catalog_isolated').trim();
  const user = (env.PGUSER || 'catalog_app').trim();
  const password = env.PGPASSWORD || 'app_pass';

  if (!ALLOWED_LOCAL_HOSTS.has(host)) {
    throw new Error(
      `H26 SEGURIDAD: Host PostgreSQL no autorizado (${host}). Solo se permite loopback local (127.0.0.1/localhost).`,
    );
  }
  if (!ISOLATED_DB_PATTERN.test(database)) {
    throw new Error(
      `H26 SEGURIDAD: Base de datos '${database}' no coincide con el patron dedicado a pruebas descartables (${ISOLATED_DB_PATTERN}).`,
    );
  }
  if (!EXPECTED_RUNTIME_ROLES.has(user)) {
    throw new Error(
      `H26 SEGURIDAD: Rol '${user}' no corresponde a un rol runtime no propietario de catalog-svc.`,
    );
  }
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(`H26 SEGURIDAD: Puerto PostgreSQL invalido (${port}).`);
  }

  return {
    expectedRole: user,
    database,
    user,
    password,
    mode: 'direct',
    pool: {
      host,
      port,
      database,
      user,
      password,
      max: 6,
      idleTimeoutMillis: 10000,
    },
  };
}

export async function verifyDisposablePg17Contract(
  database: Database,
): Promise<{
  serverVersionNum: number;
  currentDatabase: string;
  currentUser: string;
}> {
  // 1) Verifica identidad no-superuser / no-owner mediante el propio Database.verifyIdentity() productivo
  await database.verifyIdentity();

  // 2) Verifica PostgreSQL 17 real y presencia de migraciones oficiales aplicadas
  return database.read(async (db) => {
    const verRes = await db.execute(
      sql`SELECT current_setting('server_version_num')::int AS ver, current_database() AS db, current_user AS usr`,
    );
    const row = verRes.rows[0] as
      { ver: number; db: string; usr: string } | undefined;
    if (!row || row.ver < 170000 || row.ver >= 180000) {
      throw new Error(
        `H26: Se requiere PostgreSQL 17 descartable (detectado server_version_num=${row?.ver ?? 'desconocido'}).`,
      );
    }

    const tablesRes = await db.execute(sql`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'catalog'
        AND table_name IN ('products', 'outbox', 'inbox', 'outbox_delivery', 'bulk_retry_command_receipts')
    `);
    const found = new Set(
      (tablesRes.rows as Array<{ table_name: string }>).map(
        (r) => r.table_name,
      ),
    );
    for (const required of [
      'products',
      'outbox',
      'inbox',
      'outbox_delivery',
      'bulk_retry_command_receipts',
    ]) {
      if (!found.has(required)) {
        throw new Error(
          `H26: Falta tabla oficial 'catalog.${required}'. Aplique las migraciones oficiales antes de ejecutar.`,
        );
      }
    }

    return {
      serverVersionNum: row.ver,
      currentDatabase: row.db,
      currentUser: row.usr,
    };
  });
}
