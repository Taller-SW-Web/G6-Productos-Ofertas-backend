import { NestFactory } from '@nestjs/core';
import { ApiGatewayModule } from './api-gateway.module.js';

async function bootstrap() {
  const app = await NestFactory.create(ApiGatewayModule);
  const port = process.env.API_GATEWAY_PORT ?? process.env.PORT ?? 3000;
  await app.listen(port);
}
await bootstrap();