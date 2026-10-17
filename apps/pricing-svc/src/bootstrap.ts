import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { PricingSvcModule } from './pricing-svc.module.js';
import {
  InvalidPricingConfig,
  validateEnvironment,
} from './config/environment.js';
import { SafeLogger } from './logging/safe-logger.js';

export async function createApplication(env: NodeJS.ProcessEnv = process.env) {
  const config = validateEnvironment(env);
  const logger = new SafeLogger(config.nodeEnv);
  const app = await NestFactory.create(PricingSvcModule.forRoot(env), {
    logger,
    abortOnError: false,
  });
  app.enableShutdownHooks();
  return { app, config, logger };
}

export async function startPricing(): Promise<void> {
  try {
    const envPath = resolve(process.cwd(), '.env');
    if (existsSync(envPath)) process.loadEnvFile(envPath);
    const { app, config, logger } = await createApplication();
    try {
      await app.listen(config.port);
      logger.log('pricing-svc iniciado.');
    } catch (error) {
      await app.close();
      throw error;
    }
  } catch (error) {
    new SafeLogger().error(
      error instanceof InvalidPricingConfig
        ? error.message
        : 'No se pudo iniciar pricing-svc.',
    );
    process.exitCode = 1;
  }
}
