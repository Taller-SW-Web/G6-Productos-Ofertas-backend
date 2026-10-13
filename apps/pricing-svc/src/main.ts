import { NestFactory } from '@nestjs/core';
import { PricingSvcModule } from './pricing-svc.module.js';

async function bootstrap() {
  const app = await NestFactory.create(PricingSvcModule);
  const port = process.env.PRICING_SVC_PORT ?? process.env.PORT ?? 3002;
  await app.listen(port);
}
await bootstrap();