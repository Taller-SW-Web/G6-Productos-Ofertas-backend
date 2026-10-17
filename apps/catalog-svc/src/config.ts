import { readPostgresSettings, type PostgresSettings } from './database.js';
import { readHttpConfig } from './http-config.js';

export type Environment = 'development' | 'test' | 'production';

export class CatalogConfig {
  readonly environment: Environment;
  readonly port: number;
  readonly host: string;
  readonly database: PostgresSettings;

  constructor(env: Record<string, string | undefined>) {
    const errors: string[] = [];
    const environment = env.NODE_ENV;
    if (!['development', 'test', 'production'].includes(environment ?? '')) {
      errors.push('NODE_ENV debe ser development, test o production.');
    }
    if (!(env.CATALOG_SVC_PORT ?? env.PORT)) {
      errors.push('CATALOG_SVC_PORT (o PORT) es obligatorio.');
    }
    let http: ReturnType<typeof readHttpConfig> | undefined;
    try {
      http = readHttpConfig(env);
    } catch {
      errors.push('CATALOG_SVC_PORT/PORT o CATALOG_SVC_HOST invalido.');
    }
    let database: PostgresSettings | undefined;
    try {
      database = readPostgresSettings(env);
    } catch (error) {
      errors.push(
        error instanceof Error
          ? error.message
          : 'Configuracion PostgreSQL catalog invalida.',
      );
    }
    if (env.CATALOG_TAXONOMY_URL !== undefined) {
      try {
        const url = new URL(env.CATALOG_TAXONOMY_URL);
        if (
          !['http:', 'https:'].includes(url.protocol) ||
          url.username ||
          url.password ||
          url.pathname !== '/' ||
          url.search ||
          url.hash
        )
          throw new Error();
      } catch {
        errors.push(
          'CATALOG_TAXONOMY_URL debe ser un origen HTTP(S) sin credenciales.',
        );
      }
    }
    if (errors.length || !http || !database) {
      throw new Error(
        'Configuracion de catalog-svc invalida: ' + errors.join(' '),
      );
    }
    this.environment = environment as Environment;
    this.port = http.port;
    this.host = http.host;
    this.database = database;
    Object.freeze(this);
  }
}
