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
  const reservationTtlSeconds = Number(rawTtl) > 0 ? Number(rawTtl) : 900;

  const rawThreshold = process.env.DEFAULT_LOW_STOCK_THRESHOLD ?? '5';
  const defaultLowStockThreshold =
    Number(rawThreshold) >= 0 ? Number(rawThreshold) : 5;

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
  };
}
