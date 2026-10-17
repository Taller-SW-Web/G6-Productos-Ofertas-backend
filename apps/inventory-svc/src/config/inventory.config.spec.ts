import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadInventoryConfig } from './inventory.config.js';

const MANAGED_KEYS = [
  'INVENTORY_SVC_PORT',
  'PORT',
  'RESERVATION_TTL_SECONDS',
  'DEFAULT_LOW_STOCK_THRESHOLD',
  'INVENTORY_WORKER_INTERVAL_MS',
  'INVENTORY_WORKER_BATCH_SIZE',
  'PGPORT',
  'PGHOST',
  'PGUSER',
  'DATABASE_URL',
] as const;

describe('loadInventoryConfig — configuración fail-closed', () => {
  const snapshot: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of MANAGED_KEYS) {
      snapshot[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of MANAGED_KEYS) {
      if (snapshot[key] === undefined) delete process.env[key];
      else process.env[key] = snapshot[key];
    }
  });

  it('aplica los valores por defecto cuando el entorno está vacío', () => {
    const config = loadInventoryConfig();

    expect(config.port).toBe(3005);
    expect(config.reservationTtlSeconds).toBe(900);
    expect(config.defaultLowStockThreshold).toBe(5);
    expect(config.workerIntervalMs).toBe(5000);
    expect(config.workerBatchSize).toBe(50);
    expect(config.pgPort).toBe(5432);
  });

  it('rechaza DEFAULT_LOW_STOCK_THRESHOLD no numérico (fail-closed)', () => {
    process.env.DEFAULT_LOW_STOCK_THRESHOLD = 'abc';

    expect(() => loadInventoryConfig()).toThrow(/DEFAULT_LOW_STOCK_THRESHOLD/);
  });

  it('rechaza DEFAULT_LOW_STOCK_THRESHOLD negativo (fail-closed)', () => {
    process.env.DEFAULT_LOW_STOCK_THRESHOLD = '-1';

    expect(() => loadInventoryConfig()).toThrow(/DEFAULT_LOW_STOCK_THRESHOLD/);
  });

  it('acepta DEFAULT_LOW_STOCK_THRESHOLD = 0', () => {
    process.env.DEFAULT_LOW_STOCK_THRESHOLD = '0';

    expect(loadInventoryConfig().defaultLowStockThreshold).toBe(0);
  });

  it('rechaza PGPORT no numérico (fail-closed)', () => {
    process.env.PGPORT = 'abc';

    expect(() => loadInventoryConfig()).toThrow(/PGPORT/);
  });

  it('rechaza PGPORT fuera de rango (fail-closed)', () => {
    process.env.PGPORT = '70000';

    expect(() => loadInventoryConfig()).toThrow(/PGPORT/);
  });

  it('acepta un PGPORT válido', () => {
    process.env.PGPORT = '6543';

    expect(loadInventoryConfig().pgPort).toBe(6543);
  });

  it('rechaza INVENTORY_SVC_PORT inválido (fail-closed)', () => {
    process.env.INVENTORY_SVC_PORT = '0';

    expect(() => loadInventoryConfig()).toThrow(/Puerto inválido/);
  });

  it('rechaza RESERVATION_TTL_SECONDS no positivo (fail-closed)', () => {
    process.env.RESERVATION_TTL_SECONDS = '0';

    expect(() => loadInventoryConfig()).toThrow(/RESERVATION_TTL_SECONDS/);
  });
});
