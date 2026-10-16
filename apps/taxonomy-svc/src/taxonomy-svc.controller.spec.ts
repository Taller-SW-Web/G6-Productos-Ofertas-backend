import { Test, TestingModule } from '@nestjs/testing';
import { TaxonomySvcController } from './taxonomy-svc.controller.js';
import { TaxonomySvcService } from './taxonomy-svc.service.js';
import { TAXONOMY_REPOSITORY } from './taxonomy.repository.js';
import { UnconfiguredTaxonomyRepository } from './unconfigured-taxonomy.repository.js';

describe('TaxonomySvcController', () => {
  let controller: TaxonomySvcController;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [TaxonomySvcController],
      providers: [
        TaxonomySvcService,
        {
          provide: TAXONOMY_REPOSITORY,
          useClass: UnconfiguredTaxonomyRepository,
        },
      ],
    }).compile();

    controller = app.get<TaxonomySvcController>(TaxonomySvcController);
  });

  describe('health', () => {
    it('should return health status for taxonomy-svc', () => {
      expect(controller.getHealth()).toEqual({
        status: 'ok',
        service: 'taxonomy-svc',
      });
    });
  });
});
