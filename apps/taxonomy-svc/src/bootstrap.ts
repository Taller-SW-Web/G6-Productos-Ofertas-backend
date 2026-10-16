import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { INestApplication, LoggerService } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { TaxonomySvcModule } from './taxonomy-svc.module.js';
import { Database, readDatabaseConfig } from './database.js';
import { validarEntorno } from './config/environment.js';
import type { TaxonomyEnv } from './config/environment.js';
import { SanitizedLogger } from './logging/sanitized-logger.js';

export interface OpcionesArranque {
  env?: Record<string, string | undefined>;
  logger?: LoggerService;
}

export interface AplicacionCreada {
  app: INestApplication;
  env: TaxonomyEnv;
}

function cargarEnv(): void {
  const envPath = resolve(process.cwd(), '.env');
  if (existsSync(envPath) && typeof process.loadEnvFile === 'function') {
    process.loadEnvFile(envPath);
  }
}

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
  ) {
    throw new Error('Configuración HTTP taxonomy inválida');
  }
  return { port, host };
}

export async function crearAplicacion(
  opciones: OpcionesArranque = {},
): Promise<AplicacionCreada> {
  const env = opciones.env ?? process.env;
  const configuracion = validarEntorno(env);
  const logger = new SanitizedLogger(opciones.logger);
  const app = await NestFactory.create(
    TaxonomySvcModule.forRoot({ databaseUrl: configuracion.databaseUrl }),
    { logger },
  );
  app.useLogger(logger);
  logger.log('Configuracion de arranque validada', {
    entorno: configuracion.nodeEnv,
    puerto: configuracion.port,
    DATABASE_URL: configuracion.databaseUrl,
  });
  return { app, env: configuracion };
}

export async function iniciarTaxonomySvc(
  opciones: OpcionesArranque = {},
): Promise<AplicacionCreada> {
  if (!opciones.env) {
    cargarEnv();
  }

  if (process.env.PGHOST?.trim() && !opciones.env?.DATABASE_URL) {
    readDatabaseConfig(process.env);
    const { port, host } = readHttpConfig(process.env);
    const logger = new SanitizedLogger(opciones.logger);
    const app = await NestFactory.create(TaxonomySvcModule, {
      logger,
      abortOnError: false,
    });
    try {
      await app.get(Database).verifyIdentity();
      app.enableShutdownHooks();
      await app.listen(port, host);
      logger.log({ service: 'taxonomy-svc', code: 'APPLICATION_STARTED' });
      return {
        app,
        env: {
          nodeEnv: (process.env.NODE_ENV as any) ?? 'development',
          port,
          databaseUrl: '',
        },
      };
    } catch (err) {
      await app.close();
      throw err;
    }
  }

  const aplicacion = await crearAplicacion(opciones);
  await aplicacion.app.listen(aplicacion.env.port);
  return aplicacion;
}
