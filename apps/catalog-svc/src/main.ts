import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { Database, readDatabaseConfig } from './database.js';
import { readHttpConfig } from './http-config.js';

async function bootstrap(): Promise<void> {
  // --env-file externo se inyecta antes de Nest; no copiar archivos privados.
  readDatabaseConfig(process.env);
  const { port, host } = readHttpConfig(process.env);
  const app = await NestFactory.create(AppModule, {
    logger: false,
    abortOnError: false,
  });
  try {
    await app.get(Database).verifyIdentity();
    app.enableShutdownHooks();
    await app.listen(port, host);
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
