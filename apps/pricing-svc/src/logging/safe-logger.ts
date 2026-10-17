import { ConsoleLogger, type LoggerService } from '@nestjs/common';

const MESSAGES = new Set([
  'pricing-svc iniciado.',
  'Configuración inválida: revisar NODE_ENV, PRICING_SVC_PORT/PORT y DATABASE_URL/TLS.',
  'No se pudo iniciar pricing-svc.',
  'Conexión PostgreSQL inactiva no disponible.',
]);
const CONTEXTS = new Set([
  'Bootstrap',
  'PricingReadiness',
  'PricingDatabase',
  'NestFactory',
  'NestApplication',
]);

// Lista cerrada: ningún contenido externo/dinámico se serializa ni inspecciona.
function controlled(value: unknown, allowed: ReadonlySet<string>): string {
  return typeof value === 'string' && allowed.has(value) ? value : '[REDACTED]';
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
      environment: controlled(
        this.environment,
        new Set(['development', 'test', 'production', 'unknown']),
      ),
      message: controlled(message, MESSAGES),
      context: optional.map((value) => controlled(value, CONTEXTS)),
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
