import { iniciarTaxonomySvc } from './bootstrap.js';

await iniciarTaxonomySvc().catch(() => {
  process.stderr.write(
    JSON.stringify({
      service: 'taxonomy-svc',
      code: 'APPLICATION_START_FAILED',
    }) + '\n',
  );
  process.exitCode = 1;
});
