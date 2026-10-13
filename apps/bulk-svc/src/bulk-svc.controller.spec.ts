import { Test, TestingModule } from '@nestjs/testing';
import { BulkSvcController } from './bulk-svc.controller.js';
import { BulkSvcService } from './bulk-svc.service.js';

describe('BulkSvcController', () => {
  let controller: BulkSvcController;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [BulkSvcController],
      providers: [BulkSvcService],
    }).compile();

    controller = app.get<BulkSvcController>(BulkSvcController);
  });

  describe('health', () => {
    it('should return health status for bulk-svc', () => {
      expect(controller.getHealth()).toEqual({
        status: 'ok',
        service: 'bulk-svc',
      });
    });
  });
});
