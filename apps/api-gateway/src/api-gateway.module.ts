import { Module } from '@nestjs/common';
import { ApiGatewayController } from './api-gateway.controller.js';
import { ApiGatewayService } from './api-gateway.service.js';
import {
  GATEWAY_SETTINGS,
  readGatewayEnvironment,
  readGatewaySettings,
} from './routing/gateway-settings.js';
import { GatewayIdentity } from './routing/gateway-identity.js';
import { GatewayProxy } from './routing/gateway-proxy.js';
import { GatewayProxyController } from './routing/gateway-proxy.controller.js';
import { GatewayReadiness } from './routing/gateway-readiness.js';

@Module({
  imports: [],
  controllers: [ApiGatewayController, GatewayProxyController],
  providers: [
    ApiGatewayService,
    {
      provide: GATEWAY_SETTINGS,
      useFactory: () => readGatewaySettings(readGatewayEnvironment()),
    },
    GatewayIdentity,
    GatewayProxy,
    GatewayReadiness,
  ],
})
export class ApiGatewayModule {}
