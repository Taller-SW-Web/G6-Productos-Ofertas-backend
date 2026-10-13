import { NestFactory } from '@nestjs/core';
import { PromotionsSvcModule } from './promotions-svc.module.js';

async function bootstrap() {
  const app = await NestFactory.create(PromotionsSvcModule);
  const port = process.env.PROMOTIONS_SVC_PORT ?? process.env.PORT ?? 3004;
  await app.listen(port);
}
await bootstrap();