import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { INestApplication, LoggerService } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { TaxonomySvcModule } from './taxonomy-svc.module.js';
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
  });
  return { app, env: configuracion };
}

export async function iniciarTaxonomySvc(
  opciones: OpcionesArranque = {},
): Promise<AplicacionCreada> {
  if (!opciones.env) {
    cargarEnv();
  }
  const aplicacion = await crearAplicacion(opciones);
  await aplicacion.app.listen(aplicacion.env.port);
  return aplicacion;
}
