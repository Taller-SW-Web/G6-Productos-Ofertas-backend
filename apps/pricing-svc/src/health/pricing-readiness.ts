import {
  Inject,
  Injectable,
  type OnApplicationShutdown,
  Logger,
} from '@nestjs/common';
import { Pool } from 'pg';
import type { PricingConfig } from '../config/environment.js';

export const PRICING_CONFIG = Symbol('PRICING_CONFIG');

@Injectable()
export class PricingReadiness implements OnApplicationShutdown {
  private readonly pool: Pool;
  private readonly logger = new Logger(PricingReadiness.name);

  constructor(@Inject(PRICING_CONFIG) config: PricingConfig) {
    this.pool = new Pool({
      connectionString: config.databaseUrl,
      max: 2,
      connectionTimeoutMillis: 2000,
      idleTimeoutMillis: 10000,
      query_timeout: 2000,
      statement_timeout: 2000,
    });
    this.pool.on('error', () =>
      this.logger.warn('Conexión PostgreSQL inactiva no disponible.'),
    );
  }
  async check(): Promise<boolean> {
    try {
      await this.pool.query('SELECT 1 FROM pricing.prices LIMIT 0');
      return true;
    } catch {
      return false;
    }
  }
  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
