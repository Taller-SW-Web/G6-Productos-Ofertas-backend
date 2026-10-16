import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { Database, readDatabaseConfig } from './database.js';

async function bootstrap(): Promise<void> {
  // --env-file externo se inyecta antes de Nest; no copiar archivos privados.
  readDatabaseConfig(process.env);
  const raw = process.env.CATALOG_SVC_PORT ?? '3001';
  const port = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('Puerto inválido');
  const app = await NestFactory.create(AppModule, {
    logger: false,
    abortOnError: false,
  });
  try {
    await app.get(Database).verifyIdentity();
    app.enableShutdownHooks();
    await app.listen(port, '127.0.0.1');
    process.stdout.write(
      JSON.stringify({ service: 'catalog-svc', code: 'APPLICATION_STARTED' }) +
        '\n',
    );
  } catch {
    await app.close();
    throw new Error('No se pudo iniciar el servicio');
  }
}
await bootstrap().catch(() => {
  process.stderr.write(
    JSON.stringify({
      service: 'catalog-svc',
      code: 'APPLICATION_START_FAILED',
    }) + '\n',
  );
  process.exitCode = 1;
});
