import { PromotionsConfigurationError } from '../config/promotions-config.js';

export class PromotionsStartupLogger {
  constructor(
    private readonly write: (line: string) => void = (line) => {
      process.stdout.write(`${line}\n`);
    },
  ) {}

  started(): void {
    this.write(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'info',
        service: 'promotions-svc',
        code: 'APPLICATION_STARTED',
      }),
    );
  }

  failed(error: unknown): void {
    // Never serialize raw exceptions, stacks, configuration or request values.
    this.write(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'error',
        service: 'promotions-svc',
        code:
          error instanceof PromotionsConfigurationError
            ? 'CONFIGURATION_INVALID'
            : 'APPLICATION_START_FAILED',
        ...(error instanceof PromotionsConfigurationError
          ? { variables: error.variables }
          : {}),
      }),
    );
  }
}
