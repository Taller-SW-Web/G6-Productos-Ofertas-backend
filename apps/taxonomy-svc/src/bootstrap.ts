import type { INestApplication, LoggerService } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { TaxonomySvcModule } from './taxonomy-svc.module.js';
import { Database, readDatabaseConfig } from './database.js';
import { SanitizedLogger } from './logging/sanitized-logger.js';

export function readHttpConfig(env: Readonly<NodeJS.ProcessEnv>) {
  const raw = env.TAXONOMY_SVC_PORT ?? env.PORT ?? '3006';
  const port = Number(raw);
  const host = env.TAXONOMY_SVC_HOST ?? '127.0.0.1';
  if (
    !/^\d+$/.test(raw) ||
    port < 1 ||
    port > 65535 ||
    !['127.0.0.1', '0.0.0.0', '::1', '::'].includes(host) ||
    (env.NODE_ENV !== undefined &&
      !['development', 'test', 'production'].includes(env.NODE_ENV))
  )
    throw new Error('Configuración HTTP taxonomy inválida');
  return { port, host };
}

// Configuración privada inyectada antes de Nest, también con --env-file.
// Reconcilia el arranque de López conservando TLS/CA y mínimo privilegio.
export async function iniciarTaxonomySvc(
  options: { logger?: LoggerService } = {},
): Promise<INestApplication> {
  readDatabaseConfig(process.env);
  const { port, host } = readHttpConfig(process.env);
  const logger = new SanitizedLogger(options.logger);
  const app = await NestFactory.create(TaxonomySvcModule, {
    logger,
    abortOnError: false,
  });
  try {
    await app.get(Database).verifyIdentity();
    app.enableShutdownHooks();
    await app.listen(port, host);
    logger.log({ service: 'taxonomy-svc', code: 'APPLICATION_STARTED' });
    return app;
  } catch {
    await app.close();
    throw new Error('No se pudo iniciar taxonomy-svc');
  }
}
