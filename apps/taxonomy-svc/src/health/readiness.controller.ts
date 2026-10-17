import { Controller, Get, Inject } from '@nestjs/common';
import { ProblemDetailsException } from '../errors/taxonomy.errors.js';
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
    await this.ejecutarReadiness();
    return { status: 'ready', service: 'taxonomy-svc' };
  }

  @Get('ready')
  async obtenerReady(): Promise<RespuestaReadiness> {
    await this.ejecutarReadiness();
    return { status: 'ready', service: 'taxonomy-svc' };
  }

  private async ejecutarReadiness(): Promise<void> {
    const ind = this.indicador as unknown as {
      verificarReadiness?: () => Promise<void>;
      readiness?: () => Promise<boolean>;
    };
    if (typeof ind.verificarReadiness === 'function') {
      await ind.verificarReadiness();
    } else if (typeof ind.readiness === 'function') {
      const ok = await ind.readiness();
      if (!ok) {
        throw ProblemDetailsException.noDisponible(
          'Fuente de datos de taxonomía no disponible.',
        );
      }
    }
  }
}
