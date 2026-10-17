export interface PricingConfig {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  databaseUrl: string;
}

export class InvalidPricingConfig extends Error {}

export function validateEnvironment(env: NodeJS.ProcessEnv): PricingConfig {
  const nodeEnv = env.NODE_ENV;
  if (
    nodeEnv !== 'development' &&
    nodeEnv !== 'test' &&
    nodeEnv !== 'production'
  ) {
    throw new InvalidPricingConfig(
      'NODE_ENV debe ser development, test o production.',
    );
  }
  const rawPort = env.PRICING_SVC_PORT ?? env.PORT;
  const port = Number(rawPort);
  if (
    !rawPort ||
    !/^\d+$/.test(rawPort) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    throw new InvalidPricingConfig(
      'PRICING_SVC_PORT (o PORT) debe ser un entero entre 1 y 65535.',
    );
  }
  const databaseUrl = env.DATABASE_URL;
  try {
    if (
      !databaseUrl ||
      databaseUrl !== databaseUrl.trim() ||
      /\s/.test(databaseUrl)
    )
      throw new Error();
    const url = new URL(databaseUrl);
    if (
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      !url.hostname ||
      !url.username ||
      url.pathname.length <= 1 ||
      url.pathname.slice(1).includes('/') ||
      url.hash ||
      (url.port &&
        (!/^\d+$/.test(url.port) ||
          Number(url.port) < 1 ||
          Number(url.port) > 65535))
    )
      throw new Error();
  } catch {
    throw new InvalidPricingConfig(
      'DATABASE_URL debe incluir host, usuario y base PostgreSQL válidos.',
    );
  }
  return { nodeEnv, port, databaseUrl };
}
