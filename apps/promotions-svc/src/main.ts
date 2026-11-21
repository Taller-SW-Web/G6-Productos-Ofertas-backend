import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { PromotionsSvcModule } from './promotions-svc.module.js';
import { PromotionsConfigService } from './infrastructure/config/promotions-config.js';
import { PromotionsStartupLogger } from './infrastructure/logging/startup-logger.js';
import { mountCouponH5JsonParser } from './http/coupon-h5-controller.js';

async function bootstrap() {
  const logger = new PromotionsStartupLogger();
  let app: INestApplication | undefined;
  try {
    app = await NestFactory.create(PromotionsSvcModule, {
      logger: false,
      abortOnError: false,
    });
    const config = app.get(PromotionsConfigService).settings;
    if (config.serviceBus?.couponCommandsEnabled) mountCouponH5JsonParser(app);
    app.enableShutdownHooks();
    await app.listen(config.port, config.listenHost);
    logger.started();
  } catch (error: unknown) {
    if (app) await app.close().catch(() => undefined);
    logger.failed(error);
    process.exitCode = 1;
  }
}
await bootstrap();
