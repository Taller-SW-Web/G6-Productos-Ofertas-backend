import { Client, type ClientConfig } from 'pg';
import type { CatalogConfig } from './config.js';
import type { CatalogDatabase } from './readiness.js';

interface DatabaseStatus {
  role: string;
  database: string;
  can_use_schema: boolean;
  can_create_objects: boolean;
}

export function postgresOptions(config: CatalogConfig): ClientConfig {
  const database = config.database;
  const connection =
    database.mode === 'session'
      ? {
          host: database.host,
          port: database.port,
          database: database.database,
          user: database.user,
          password: database.password,
          ssl: {
            ca: database.ca,
            rejectUnauthorized: true,
            servername: database.host,
          },
        }
      : { connectionString: database.connectionString };
  return {
    ...connection,
    application_name: 'catalog-svc-readiness',
    connectionTimeoutMillis: 1000,
    query_timeout: 1000,
    statement_timeout: 1000,
  };
}

/** A fresh, bounded connection avoids stale success after an outage. No ORM or DML. */
export class PostgresReadiness implements CatalogDatabase {
  constructor(private readonly config: CatalogConfig) {}

  async check(): Promise<void> {
    const client = new Client(postgresOptions(this.config));
    // A disconnect between a completed query and end() must not crash the process.
    client.on('error', () => {});
    try {
      await client.connect();
      const result = await client.query<DatabaseStatus>(
        `SELECT current_user AS role, current_database() AS database,
                has_schema_privilege(current_user, 'catalog', 'USAGE') AS can_use_schema,
                has_schema_privilege(current_user, 'catalog', 'CREATE') AS can_create_objects`,
      );
      const status = result.rows[0];
      const database = this.config.database;
      const url =
        database.mode === 'url'
          ? new URL(database.connectionString)
          : undefined;
      const expectedDatabase =
        database.mode === 'session'
          ? database.database
          : decodeURIComponent(url!.pathname.slice(1));
      const user =
        database.mode === 'session'
          ? database.user
          : decodeURIComponent(url!.username);
      // Supavisor's project suffix is routing metadata, not part of current_user.
      const expectedRole =
        database.mode === 'session' ? user.split('.')[0] : user;
      if (
        !status ||
        !status.can_use_schema ||
        status.can_create_objects ||
        status.database !== expectedDatabase ||
        status.role !== expectedRole
      ) {
        throw new Error('Catalog database readiness failed');
      }
    } finally {
      await client.end();
    }
  }
}
