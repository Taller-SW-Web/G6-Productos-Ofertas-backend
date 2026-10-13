import { NestFactory } from '@nestjs/core';
import { PriceAuditSvcModule } from './price-audit-svc.module.js';

async function bootstrap() {
  const app = await NestFactory.create(PriceAuditSvcModule);
  const port = process.env.PRICE_AUDIT_SVC_PORT ?? process.env.PORT ?? 3003;
  await app.listen(port);
}
await bootstrap();