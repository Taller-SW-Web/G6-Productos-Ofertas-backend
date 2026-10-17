import { readFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import { checkServerIdentity, type ConnectionOptions } from 'node:tls';

export const PRICING_CONFIG = Symbol('PRICING_CONFIG');

export interface PricingConfig {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  databaseUrl: string;
  databaseSsl: false | ConnectionOptions;
  auth?: { issuer: string; jwksUrl: string };
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
  let url: URL;
  try {
    if (
      !databaseUrl ||
      databaseUrl !== databaseUrl.trim() ||
      /\s/.test(databaseUrl)
    )
      throw new Error();
    url = new URL(databaseUrl);
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
  // No dejar que el parser de pg reemplace ssl o el host validado desde la URL.
  for (const key of url.searchParams.keys()) {
    if (
      !['sslmode', 'sslrootcert'].includes(key) ||
      url.searchParams.getAll(key).length !== 1
    ) {
      throw new InvalidPricingConfig(
        'DATABASE_URL solo permite parámetros sslmode y sslrootcert únicos.',
      );
    }
  }
  if (
    env.NODE_TLS_REJECT_UNAUTHORIZED === '0' ||
    process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0'
  ) {
    throw new InvalidPricingConfig(
      'La validación TLS global debe permanecer habilitada.',
    );
  }
  const mode = url.searchParams.get('sslmode') ?? env.PGSSLMODE;
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(
    url.hostname.toLowerCase(),
  );
  const allowPlaintext =
    nodeEnv !== 'production' &&
    local &&
    (mode === undefined || mode === 'disable');
  let databaseSsl: PricingConfig['databaseSsl'] = false;
  if (!allowPlaintext) {
    if (mode !== 'verify-full') {
      throw new InvalidPricingConfig(
        'DATABASE_URL requiere sslmode=verify-full fuera de pruebas locales aisladas.',
      );
    }
    databaseSsl = { rejectUnauthorized: true, checkServerIdentity };
    const caPath = url.searchParams.get('sslrootcert') ?? env.PGSSLROOTCERT;
    if (caPath !== undefined) {
      try {
        const ca = readFileSync(caPath, 'utf8');
        new X509Certificate(ca);
        databaseSsl.ca = ca;
      } catch {
        throw new InvalidPricingConfig(
          'PGSSLROOTCERT/sslrootcert debe contener una CA legible.',
        );
      }
    }
  }
  url.search = '';
  let auth: PricingConfig['auth'];
  if (env.AUTH_ISSUER !== undefined || env.AUTH_JWKS_URL !== undefined) {
    try {
      for (const value of [env.AUTH_ISSUER, env.AUTH_JWKS_URL]) {
        if (!value || value !== value.trim()) throw new Error();
        const endpoint = new URL(value);
        if (
          endpoint.username ||
          endpoint.password ||
          endpoint.hash ||
          (endpoint.protocol !== 'https:' &&
            !(
              nodeEnv === 'test' &&
              endpoint.protocol === 'http:' &&
              ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)
            ))
        )
          throw new Error();
      }
      auth = { issuer: env.AUTH_ISSUER!, jwksUrl: env.AUTH_JWKS_URL! };
    } catch {
      throw new InvalidPricingConfig(
        'AUTH_ISSUER y AUTH_JWKS_URL deben ser URLs seguras válidas.',
      );
    }
  }
  return {
    nodeEnv,
    port,
    databaseUrl: url.toString(),
    databaseSsl,
    ...(auth ? { auth } : {}),
  };
}
