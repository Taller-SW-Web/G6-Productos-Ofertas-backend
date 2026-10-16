import { Controller, Get, Inject } from '@nestjs/common';
import { TAXONOMY_READINESS } from './readiness.port.js';
import type { TaxonomyReadinessIndicator } from './readiness.port.js';

export interface RespuestaReadiness {
  status: 'ready';
  service: 'taxonomy-svc';
}

@Controller('health')
export class ReadinessController {
  constructor(
    @Inject(TAXONOMY_READINESS)
    private readonly indicador: TaxonomyReadinessIndicator,
  ) {}

  @Get('readiness')
  async obtenerReadiness(): Promise<RespuestaReadiness> {
    await this.indicador.verificarReadiness();
    return { status: 'ready', service: 'taxonomy-svc' };
  }
}
