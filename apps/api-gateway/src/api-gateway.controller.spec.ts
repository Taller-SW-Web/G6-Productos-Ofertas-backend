import { Test, TestingModule } from '@nestjs/testing';
import { ApiGatewayController } from './api-gateway.controller.js';
import { ApiGatewayService } from './api-gateway.service.js';

describe('ApiGatewayController', () => {
  let controller: ApiGatewayController;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [ApiGatewayController],
      providers: [ApiGatewayService],
    }).compile();

    controller = app.get<ApiGatewayController>(ApiGatewayController);
  });

  describe('health', () => {
    it('should return health status for api-gateway', () => {
      expect(controller.getHealth()).toEqual({
        status: 'ok',
        service: 'api-gateway',
      });
    });
  });
});
