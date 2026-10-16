import {
  Controller,
  Get,
  Inject,
  ServiceUnavailableException,
} from '@nestjs/common';
import { TAXONOMY_REPOSITORY } from './taxonomy.repository.js';
import { PostgresTaxonomyRepository } from './postgres-taxonomy.repository.js';

@Controller('health')
export class ReadinessController {
  constructor(
    @Inject(TAXONOMY_REPOSITORY)
    private readonly repository: PostgresTaxonomyRepository,
  ) {}
  @Get('ready')
  async ready() {
    if (!(await this.repository.readiness()))
      throw new ServiceUnavailableException();
    return { status: 'ready', service: 'taxonomy-svc' };
  }
}
