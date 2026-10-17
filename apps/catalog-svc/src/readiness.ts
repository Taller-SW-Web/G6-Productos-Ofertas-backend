import {
  Controller,
  Get,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';

export const CATALOG_DATABASE = Symbol('CATALOG_DATABASE');

/** The persistence adapter must execute an authenticated, read-only DB query. */
export interface CatalogDatabase {
  check(): Promise<void>;
}

@Injectable()
export class UnconfiguredDatabase implements CatalogDatabase {
  async check(): Promise<void> {
    throw new Error('Catalog database adapter is not configured');
  }
}

@Controller('health')
export class ReadinessController {
  constructor(
    @Inject(CATALOG_DATABASE) private readonly database: CatalogDatabase,
  ) {}

  @Get('ready')
  async ready() {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.database.check(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Readiness timeout')),
            2000,
          );
        }),
      ]);
      return { status: 'ready', service: 'catalog-svc' };
    } catch {
      throw new ServiceUnavailableException({
        status: 'not_ready',
        service: 'catalog-svc',
        dependencies: { database: 'unavailable' },
      });
    } finally {
      clearTimeout(timer);
    }
  }
}
