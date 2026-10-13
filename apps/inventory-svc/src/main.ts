import { NestFactory } from '@nestjs/core';
import { InventorySvcModule } from './inventory-svc.module.js';

async function bootstrap() {
  const app = await NestFactory.create(InventorySvcModule);
  const port = process.env.INVENTORY_SVC_PORT ?? process.env.PORT ?? 3005;
  await app.listen(port);
}
await bootstrap();