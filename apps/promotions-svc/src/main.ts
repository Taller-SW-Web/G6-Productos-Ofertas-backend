import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { PromotionsSvcModule } from './promotions-svc.module.js';

function loadEnv(): void {
  const envPath = resolve(process.cwd(), '.env');
  if (existsSync(envPath) && typeof process.loadEnvFile === 'function') {
    process.loadEnvFile(envPath);
  }
}

function resolvePort(): number {
  const rawPort = process.env.PROMOTIONS_SVC_PORT ?? process.env.PORT ?? '3004';
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      '[' +
        'promotions-svc' +
        '] Puerto invalido: ' +
        String(rawPort) +
        '. Debe ser un entero entre 1 y 65535.',
    );
  }
  return port;
}

async function bootstrap() {
  loadEnv();
  const port = resolvePort();
  const app = await NestFactory.create(PromotionsSvcModule);
  await app.listen(port);
}
await bootstrap();
