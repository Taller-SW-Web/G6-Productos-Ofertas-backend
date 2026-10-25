import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
} from '@nestjs/common';
import { Pool } from 'pg';
import {
  BULK_ENVIRONMENT,
  BULK_READINESS_POOL,
  type BulkEnvironment,
} from '../config/bulk-environment.js';

export interface BulkReadinessPool {
  query(sql: string): Promise<unknown>;
  end(): Promise<void>;
  on(event: 'error', listener: () => void): this;
}

export function createBulkReadinessPool(
  config: BulkEnvironment,
): BulkReadinessPool | null {
  if (!config.databaseUrl) return null;
  const pool = new Pool({
    connectionString: config.databaseUrl,
    ssl: config.databaseSsl,
    max: config.databasePoolMax,
    connectionTimeoutMillis: config.databaseConnectionTimeoutMs,
    query_timeout: config.databaseQueryTimeoutMs,
    statement_timeout: config.databaseQueryTimeoutMs,
    idleTimeoutMillis: config.databaseIdleTimeoutMs,
  });
  const logger = new Logger('BulkReadinessService');
  pool.on('error', () =>
    logger.warn('Conexión PostgreSQL inactiva no disponible.'),
  );
  return pool;
}

@Injectable()
export class BulkReadinessService implements OnModuleDestroy {
  private readonly logger = new Logger(BulkReadinessService.name);

  constructor(
    @Inject(BULK_ENVIRONMENT) private readonly config: BulkEnvironment,
    @Inject(BULK_READINESS_POOL)
    private readonly pool: BulkReadinessPool | null,
  ) {}

  async check(): Promise<boolean> {
    if (!this.config.databaseUrl || !this.pool) return false;
    try {
      await this.pool.query('SELECT 1 FROM bulk.batch_jobs LIMIT 0');
      return true;
    } catch {
      this.logger.warn('La comprobación de PostgreSQL no está disponible.');
      return false;
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.pool) await this.pool.end();
  }
}
