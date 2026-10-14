export interface InventoryConfig {
  databaseUrl?: string;
  pgHost?: string;
  pgPort?: number;
  pgDatabase?: string;
  pgUser?: string;
  pgPassword?: string;
  pgSslMode?: string;
  pgSslRootCert?: string;
  rabbitMqUrl?: string;
  port: number;
  reservationTtlSeconds: number;
  defaultLowStockThreshold: number;
  workerIntervalMs: number;
  workerBatchSize: number;
}

export function loadInventoryConfig(): InventoryConfig {
  const rawPort = process.env.INVENTORY_SVC_PORT ?? process.env.PORT ?? '3005';
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `[inventory-svc] Puerto inválido: ${rawPort}. Debe ser un entero entre 1 y 65535.`,
    );
  }

  const rawTtl = process.env.RESERVATION_TTL_SECONDS ?? '900';
  const ttlNumber = Number(rawTtl);
  if (
    !Number.isInteger(ttlNumber) ||
    ttlNumber <= 0 ||
    !Number.isFinite(ttlNumber)
  ) {
    throw new Error(
      `[inventory-svc] RESERVATION_TTL_SECONDS inválido: "${rawTtl}". Debe ser un entero positivo finito.`,
    );
  }
  const reservationTtlSeconds = ttlNumber;

  const rawThreshold = process.env.DEFAULT_LOW_STOCK_THRESHOLD ?? '5';
  const thresholdNum = Number(rawThreshold);
  const defaultLowStockThreshold =
    Number.isInteger(thresholdNum) && thresholdNum >= 0 ? thresholdNum : 5;

  const rawWorkerInterval = process.env.INVENTORY_WORKER_INTERVAL_MS ?? '5000';
  const workerIntervalMs = Number(rawWorkerInterval);
  if (!Number.isInteger(workerIntervalMs) || workerIntervalMs < 250) {
    throw new Error(
      `[inventory-svc] INVENTORY_WORKER_INTERVAL_MS inválido: "${rawWorkerInterval}". Debe ser un entero >= 250.`,
    );
  }
  const rawWorkerBatchSize = process.env.INVENTORY_WORKER_BATCH_SIZE ?? '50';
  const workerBatchSize = Number(rawWorkerBatchSize);
  if (
    !Number.isInteger(workerBatchSize) ||
    workerBatchSize < 1 ||
    workerBatchSize > 500
  ) {
    throw new Error(
      `[inventory-svc] INVENTORY_WORKER_BATCH_SIZE inválido: "${rawWorkerBatchSize}". Debe ser un entero entre 1 y 500.`,
    );
  }

  return {
    databaseUrl: process.env.DATABASE_URL,
    pgHost: process.env.PGHOST,
    pgPort: process.env.PGPORT ? Number(process.env.PGPORT) : 5432,
    pgDatabase: process.env.PGDATABASE,
    pgUser: process.env.PGUSER,
    pgPassword: process.env.PGPASSWORD,
    pgSslMode: process.env.PGSSLMODE,
    pgSslRootCert: process.env.PGSSLROOTCERT,
    rabbitMqUrl: process.env.RABBITMQ_URL,
    port,
    reservationTtlSeconds,
    defaultLowStockThreshold,
    workerIntervalMs,
    workerBatchSize,
  };
}
