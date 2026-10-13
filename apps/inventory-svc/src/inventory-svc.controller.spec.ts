import { Test, TestingModule } from '@nestjs/testing';
import { InventorySvcController } from './inventory-svc.controller.js';
import { InventorySvcService } from './inventory-svc.service.js';

describe('InventorySvcController', () => {
  let controller: InventorySvcController;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [InventorySvcController],
      providers: [InventorySvcService],
    }).compile();

    controller = app.get<InventorySvcController>(InventorySvcController);
  });

  describe('health', () => {
    it('should return health status for inventory-svc', () => {
      expect(controller.getHealth()).toEqual({
        status: 'ok',
        service: 'inventory-svc',
      });
    });
  });
});
