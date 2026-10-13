import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const port = process.env.CATALOG_SVC_PORT ?? process.env.PORT ?? 3001;
  await app.listen(port);
}
await bootstrap();
