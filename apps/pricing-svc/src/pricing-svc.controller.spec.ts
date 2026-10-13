import { Test, TestingModule } from '@nestjs/testing';
import { PricingSvcController } from './pricing-svc.controller.js';
import { PricingSvcService } from './pricing-svc.service.js';

describe('PricingSvcController', () => {
  let controller: PricingSvcController;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [PricingSvcController],
      providers: [PricingSvcService],
    }).compile();

    controller = app.get<PricingSvcController>(PricingSvcController);
  });

  describe('health', () => {
    it('should return health status for pricing-svc', () => {
      expect(controller.getHealth()).toEqual({
        status: 'ok',
        service: 'pricing-svc',
      });
    });
  });
});