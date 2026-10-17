import { readPostgresSettings, type PostgresSettings } from './database.js';
import { readTaxonomyConfig, type TaxonomyConfig } from './taxonomy-config.js';
import { readHttpConfig } from './http-config.js';

export type Environment = 'development' | 'test' | 'production';

export class CatalogConfig {
  readonly environment: Environment;
  readonly port: number;
  readonly host: string;
  readonly database: PostgresSettings;
  readonly taxonomy: TaxonomyConfig;

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
    let taxonomy: TaxonomyConfig | undefined;
    try {
      taxonomy = readTaxonomyConfig(env);
    } catch {
      errors.push(
        'CATALOG_TAXONOMY_URL debe ser un origen HTTP(S) sin credenciales.',
      );
    }
    if (errors.length || !http || !database || !taxonomy) {
      throw new Error(
        'Configuracion de catalog-svc invalida: ' + errors.join(' '),
      );
    }
    this.environment = environment as Environment;
    this.port = http.port;
    this.host = http.host;
    this.database = database;
    this.taxonomy = taxonomy;
    Object.freeze(this);
  }
}
