import { NestFactory } from '@nestjs/core';
import { ApiGatewayModule } from './api-gateway.module.js';
import {
  readGatewayEnvironment,
  readGatewayPort,
} from './routing/gateway-settings.js';

async function bootstrap() {
  const port = readGatewayPort(readGatewayEnvironment());
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
