import { ConsoleLogger, type LoggerService } from '@nestjs/common';

// Objetos, errores y mensajes sensibles se omiten completos: no serializar payloads.
function safeMessage(value: unknown): string {
  if (
    typeof value !== 'string' ||
    /:\/\/|\bBearer\s|\beyJ[A-Za-z0-9_-]*\.|password|passwd|secret|token|authorization|cookie|credential|api[_-]?key/i.test(
      value,
    )
  ) {
    return '[REDACTED]';
  }
  return value;
}

export class SafeLogger implements LoggerService {
  constructor(
    private readonly environment: string = 'unknown',
    private readonly destination: LoggerService = new ConsoleLogger({
      json: true,
    }),
  ) {}

  private write(
    level: 'log' | 'error' | 'warn' | 'debug' | 'verbose' | 'fatal',
    message: unknown,
    optional: unknown[],
  ): void {
    const record = {
      service: 'pricing-svc',
      environment: this.environment,
      message: safeMessage(message),
      context: optional.map(safeMessage),
    };
    this.destination[level]?.(record);
  }
  log(message: unknown, ...optional: unknown[]): void {
    this.write('log', message, optional);
  }
  error(message: unknown, ...optional: unknown[]): void {
    this.write('error', message, optional);
  }
  warn(message: unknown, ...optional: unknown[]): void {
    this.write('warn', message, optional);
  }
  debug(message: unknown, ...optional: unknown[]): void {
    this.write('debug', message, optional);
  }
  verbose(message: unknown, ...optional: unknown[]): void {
    this.write('verbose', message, optional);
  }
  fatal(message: unknown, ...optional: unknown[]): void {
    this.write('fatal', message, optional);
  }
}
