import { NestFactory } from '@nestjs/core';
import { ApiGatewayModule } from './api-gateway.module.js';
import { readGatewayEnvironment } from './routing/gateway-settings.js';

function resolvePort(): number {
  const env = readGatewayEnvironment();
  const rawPort = env.API_GATEWAY_PORT ?? env.PORT ?? '3000';
  const port = Number(rawPort);
  if (
    !/^\d+$/.test(rawPort) ||
    rawPort.trim() !== rawPort ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    throw new Error(
      '[api-gateway] Puerto invalido. Debe ser un entero entre 1 y 65535.',
    );
  }
  return port;
}

async function bootstrap() {
  const port = resolvePort();
  const app = await NestFactory.create(ApiGatewayModule, {
    bodyParser: false,
    logger: false,
    abortOnError: false,
  });
  app.enableShutdownHooks();
  await app.listen(port);
  process.stdout.write(
    JSON.stringify({ service: 'api-gateway', code: 'APPLICATION_STARTED' }) +
      '\n',
  );
}
await bootstrap().catch(() => {
  process.stderr.write(
    JSON.stringify({
      service: 'api-gateway',
      code: 'APPLICATION_START_FAILED',
    }) + '\n',
  );
  process.exitCode = 1;
});
