import { Test, TestingModule } from '@nestjs/testing';
import { PromotionsSvcController } from './promotions-svc.controller.js';
import { PromotionsSvcService } from './promotions-svc.service.js';

describe('PromotionsSvcController', () => {
  let controller: PromotionsSvcController;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [PromotionsSvcController],
      providers: [PromotionsSvcService],
    }).compile();

    controller = app.get<PromotionsSvcController>(PromotionsSvcController);
  });

  describe('health', () => {
    it('should return health status for promotions-svc', () => {
      expect(controller.getHealth()).toEqual({
        status: 'ok',
        service: 'promotions-svc',
      });
    });
  });
});
