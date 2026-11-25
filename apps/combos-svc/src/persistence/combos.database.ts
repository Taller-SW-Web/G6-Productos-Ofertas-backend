import {
  HttpException,
  Injectable,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { readCombosEnvironment } from '../config/combos-environment.js';
import { combosTables } from './combos.schema.js';

@Injectable()
export class CombosDatabase implements OnModuleDestroy {
  private pool?: pg.Pool;
  private closed = false;
  private getPool(): pg.Pool {
    if (this.closed) throw new Error('DATABASE_CLOSED');
    if (!this.pool) {
      const settings = readCombosEnvironment(process.env);
      this.pool = new pg.Pool(settings.pool);
      this.pool.on('error', () =>
        process.stderr.write(
          '{"service":"combos-svc","code":"DATABASE_IDLE_FAILURE"}\n',
        ),
      );
    }
    return this.pool;
  }
  drizzle() {
    return drizzle(this.getPool(), { schema: combosTables });
  }
  async query<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    let client: pg.PoolClient;
    try {
      client = await this.getPool().connect();
    } catch {
      throw new ServiceUnavailableException(
        'Servicio temporalmente no disponible',
      );
    }
    try {
      return await fn(client);
    } catch (error) {
      if (error instanceof HttpException) throw error;
      const code =
        typeof error === 'object' && error !== null && 'code' in error
          ? String(error.code)
          : '';
      if (
        code.startsWith('08') ||
        code.startsWith('ECONN') ||
        code === 'ETIMEDOUT'
      ) {
        throw new ServiceUnavailableException(
          'Servicio temporalmente no disponible',
        );
      }
      if (code === '22P02' || code === '22003')
        throw new HttpException({ code: 'VALIDACION' }, 400, { cause: error });
      if (code === '23505')
        throw new HttpException({ code: 'VERSION_CONFLICT' }, 409, {
          cause: error,
        });
      if (code === '23503' || code === '23514')
        throw new HttpException({ code: 'VALIDACION' }, 422, { cause: error });
      throw error;
    } finally {
      client.release();
    }
  }
  async readyDetailed(): Promise<{
    available: boolean;
    permissionsOk: boolean;
  }> {
    try {
      return await this.query(async (c) => {
        await c.query('BEGIN READ ONLY');
        try {
          await c.query("SET LOCAL statement_timeout = '2000'");
          await c.query('SELECT 1 FROM combos.combos LIMIT 0');
          const { rows } = await c.query<{ ok: boolean }>(
            `SELECT (
              has_schema_privilege(current_user, 'combos', 'USAGE')
              AND has_table_privilege(current_user, 'combos.combos', 'SELECT')
              AND has_table_privilege(current_user, 'combos.combo_items', 'SELECT')
              AND has_table_privilege(current_user, 'combos.component_projection', 'SELECT')
              AND has_table_privilege(current_user, 'combos.component_projection', 'INSERT')
              AND has_table_privilege(current_user, 'combos.component_projection', 'UPDATE')
              AND has_table_privilege(current_user, 'combos.inbox', 'SELECT')
              AND has_table_privilege(current_user, 'combos.inbox', 'INSERT')
            ) AS ok`,
          );
          await c.query('COMMIT');
          return {
            available: true,
            permissionsOk: rows[0]?.ok === true,
          };
        } catch (error) {
          await c.query('ROLLBACK').catch(() => undefined);
          throw error;
        }
      });
    } catch {
      return { available: false, permissionsOk: false };
    }
  }
  async ready(): Promise<boolean> {
    const detailed = await this.readyDetailed();
    return detailed.available && detailed.permissionsOk;
  }
  async onModuleDestroy(): Promise<void> {
    this.closed = true;
    await this.pool?.end();
  }
}
