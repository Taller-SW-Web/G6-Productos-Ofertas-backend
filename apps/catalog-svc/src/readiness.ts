import {
  Controller,
  Get,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { pathToFileURL } from 'node:url';
import type { CommercialEligibilityPolicy } from './commercial-eligibility.js';

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

async function runReadinessProbe(): Promise<void> {
  const [
    { NestFactory },
    { AppModule },
    { Database },
    eligibility,
    repository,
  ] = await Promise.all([
    import('@nestjs/core'),
    import('./app.module.js'),
    import('./database.js'),
    import('./commercial-eligibility.js'),
    import('./postgres-catalog.repository.js'),
  ]);
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: false,
    abortOnError: false,
  });
  let database = 'not_ready';
  let status = 'not_ready';
  try {
    await app.get(Database).verifyIdentity();
    await app.get(repository.PostgresCatalogRepository).listCandidates({
      canal: 'MARKETPLACE',
      pagina: 1,
      tamanio: 1,
      orden: 'NOMBRE_ASC',
    });
    database = 'ready';
    await app
      .get<CommercialEligibilityPolicy>(eligibility.COMMERCIAL_ELIGIBILITY)
      .resolve('MARKETPLACE');
    status = 'ready';
  } catch {
    status = 'not_ready';
  } finally {
    await app.close();
  }
  process.stdout.write(
    JSON.stringify({
      service: 'catalog-svc',
      status,
      database,
      eligibility: status === 'ready' ? 'ready' : 'unverified',
    }) + '\n',
  );
  if (status !== 'ready') process.exitCode = 1;
}

// Finish evaluating this module before the CLI imports AppModule, which imports it.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void runReadinessProbe().catch(() => {
    process.stdout.write(
      JSON.stringify({ service: 'catalog-svc', status: 'not_ready' }) + '\n',
    );
    process.exitCode = 1;
  });
}
