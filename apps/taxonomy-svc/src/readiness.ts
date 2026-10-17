import { NestFactory } from '@nestjs/core';
import { TaxonomySvcModule } from './taxonomy-svc.module.js';
import { Database } from './database.js';
import { TAXONOMY_REPOSITORY } from './taxonomy.repository.js';
import { PostgresTaxonomyRepository } from './postgres-taxonomy.repository.js';

const app = await NestFactory.createApplicationContext(TaxonomySvcModule, {
  logger: false,
  abortOnError: false,
});
let database = 'not_ready';
let status = 'not_ready';
try {
  await app.get(Database).verifyIdentity();
  if (
    await app.get<PostgresTaxonomyRepository>(TAXONOMY_REPOSITORY).readiness()
  ) {
    database = 'ready';
    status = 'ready';
  }
} catch {
  status = 'not_ready';
} finally {
  await app.close();
}
process.stdout.write(
  JSON.stringify({ service: 'taxonomy-svc', status, database }) + '\n',
);
if (status !== 'ready') process.exitCode = 1;
