import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { Database } from './database.js';
import { CommercialService } from './commercial.service.js';

@Controller('health')
export class ReadinessController {
  constructor(
    private readonly database: Database,
    private readonly commercial: CommercialService,
  ) {}
  @Get('ready')
  async ready() {
    try {
      await this.database.verifyIdentity();
      await this.commercial.list({
        canal: 'MARKETPLACE',
        pagina: 1,
        tamanio: 1,
        orden: 'NOMBRE_ASC',
      });
      return { status: 'ready', service: 'catalog-svc' };
    } catch {
      throw new ServiceUnavailableException();
    }
  }
}
