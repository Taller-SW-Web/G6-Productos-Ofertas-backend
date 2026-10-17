import { iniciarTaxonomySvc } from './bootstrap.js';
import { ConfiguracionInvalidaError } from './config/environment.js';
import { SanitizedLogger } from './logging/sanitized-logger.js';

async function arrancar(): Promise<void> {
  const logger = new SanitizedLogger();
  try {
    await iniciarTaxonomySvc({ logger });
  } catch (error) {
    const detalle =
      error instanceof ConfiguracionInvalidaError
        ? error.message
        : 'Fallo al iniciar taxonomy-svc.';
    logger.error(detalle, 'Bootstrap');
    process.stderr.write(
      JSON.stringify({
        service: 'taxonomy-svc',
        code: 'APPLICATION_START_FAILED',
      }) + '\n',
    );
    process.exit(1);
  }
}

await arrancar();
