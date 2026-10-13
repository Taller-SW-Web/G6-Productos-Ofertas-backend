import { NestFactory } from '@nestjs/core';
import { CombosSvcModule } from './combos-svc.module.js';

async function bootstrap() {
  const app = await NestFactory.create(CombosSvcModule);
  const port = process.env.COMBOS_SVC_PORT ?? process.env.PORT ?? 3007;
  await app.listen(port);
}
await bootstrap();