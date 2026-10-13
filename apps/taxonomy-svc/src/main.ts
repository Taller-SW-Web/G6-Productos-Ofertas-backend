import { NestFactory } from '@nestjs/core';
import { TaxonomySvcModule } from './taxonomy-svc.module.js';

async function bootstrap() {
  const app = await NestFactory.create(TaxonomySvcModule);
  const port = process.env.TAXONOMY_SVC_PORT ?? process.env.PORT ?? 3006;
  await app.listen(port);
}
await bootstrap();