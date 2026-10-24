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
  readonly marketplaceDemoPreview: boolean;
  readonly pricingOrigin?: string;

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
    const preview = env.CATALOG_MARKETPLACE_DEMO_PREVIEW_ENABLED;
    if (preview !== undefined && !['true', 'false'].includes(preview)) {
      errors.push(
        'CATALOG_MARKETPLACE_DEMO_PREVIEW_ENABLED debe ser true o false.',
      );
    }
    let pricingOrigin: string | undefined;
    if (env.CATALOG_PRICING_URL !== undefined) {
      try {
        const url = new URL(env.CATALOG_PRICING_URL);
        if (
          url.protocol !== 'http:' ||
          url.hostname !== 'pricing-svc' ||
          url.port !== '3002' ||
          url.username ||
          url.password ||
          url.pathname !== '/' ||
          url.search ||
          url.hash
        )
          throw new Error();
        pricingOrigin = url.origin;
      } catch {
        errors.push(
          'CATALOG_PRICING_URL debe usar el origen privado pricing-svc:3002.',
        );
      }
    }
    if (preview === 'true' && !pricingOrigin) {
      errors.push('CATALOG_PRICING_URL es obligatorio para la demo.');
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
    this.marketplaceDemoPreview = preview === 'true';
    this.pricingOrigin = pricingOrigin;
    Object.freeze(this);
  }
}
