import { Test, TestingModule } from '@nestjs/testing';
import { PriceAuditSvcController } from './price-audit-svc.controller.js';
import { PriceAuditSvcService } from './price-audit-svc.service.js';

describe('PriceAuditSvcController', () => {
  let controller: PriceAuditSvcController;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [PriceAuditSvcController],
      providers: [PriceAuditSvcService],
    }).compile();

    controller = app.get<PriceAuditSvcController>(PriceAuditSvcController);
  });

  describe('health', () => {
    it('should return health status for price-audit-svc', () => {
      expect(controller.getHealth()).toEqual({
        status: 'ok',
        service: 'price-audit-svc',
      });
    });
  });
});
