import { NestFactory } from '@nestjs/core';
import { BulkSvcModule } from './bulk-svc.module.js';

async function bootstrap() {
  const app = await NestFactory.create(BulkSvcModule);
  const port = process.env.BULK_SVC_PORT ?? process.env.PORT ?? 3008;
  await app.listen(port);
}
await bootstrap();