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

function integerSetting(
  name: string,
  fallback: number,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (
    !/^\d+$/.test(raw.trim()) ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    // No registrar el valor recibido: puede contener material confidencial.
    const label =
      name === 'INVENTORY_SVC_PORT' || name === 'PORT'
        ? `Puerto inválido (${name})`
        : `${name} inválido`;
    throw new Error(
      `[inventory-svc] ${label}. Debe ser un entero decimal entre ${minimum} y ${maximum}.`,
    );
  }
  return value;
}

export function loadInventoryConfig(): InventoryConfig {
  const portName =
    process.env.INVENTORY_SVC_PORT === undefined
      ? 'PORT'
      : 'INVENTORY_SVC_PORT';
  const port = integerSetting(portName, 3005, 1, 65535);
  const reservationTtlSeconds = integerSetting(
    'RESERVATION_TTL_SECONDS',
    900,
    1,
  );
  const defaultLowStockThreshold = integerSetting(
    'DEFAULT_LOW_STOCK_THRESHOLD',
    5,
    0,
  );
  // Node convierte intervalos mayores al máximo de int32 en un intervalo de 1 ms.
  const workerIntervalMs = integerSetting(
    'INVENTORY_WORKER_INTERVAL_MS',
    5000,
    250,
    2147483647,
  );
  const workerBatchSize = integerSetting(
    'INVENTORY_WORKER_BATCH_SIZE',
    50,
    1,
    500,
  );
  const pgPort = integerSetting('PGPORT', 5432, 1, 65535);

  return {
    databaseUrl: process.env.DATABASE_URL,
    pgHost: process.env.PGHOST,
    pgPort,
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
