import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { Database } from './database.js';
import {
  COMMERCIAL_ELIGIBILITY,
  type CommercialEligibilityPolicy,
} from './commercial-eligibility.js';
import { PostgresCatalogRepository } from './postgres-catalog.repository.js';

const app = await NestFactory.createApplicationContext(AppModule, {
  logger: false,
  abortOnError: false,
});
let database = 'not_ready';
let status = 'not_ready';
try {
  await app.get(Database).verifyIdentity();
  await app.get(PostgresCatalogRepository).listCandidates({
    canal: 'MARKETPLACE',
    pagina: 1,
    tamanio: 1,
    orden: 'NOMBRE_ASC',
  });
  database = 'ready';
  await app
    .get<CommercialEligibilityPolicy>(COMMERCIAL_ELIGIBILITY)
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
