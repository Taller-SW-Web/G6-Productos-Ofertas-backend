import { SafeLogger } from './safe-logger.js';

describe('SafeLogger', () => {
  it.each(['log', 'error', 'warn', 'debug', 'verbose', 'fatal'] as const)(
    'omite secretos y objetos también en los argumentos de %s',
    (level) => {
      const sink = {
        log: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
        verbose: vi.fn(),
        fatal: vi.fn(),
      };
      const logger = new SafeLogger('test', sink);
      const secret = 'fixture-sensitive-value';
      const cycle: Record<string, unknown> = { password: secret };
      cycle.self = cycle;
      for (const value of [
        `postgresql://user:${secret}@host/db`,
        `Bearer ${secret}`,
        `client_secret=${secret}`,
        `password=${secret}`,
        'eyJhbGciOiJIUzI1NiJ9.fixture.signature',
        { authorization: secret },
        new Error(secret),
        cycle,
      ])
        logger[level](value, value);
      const output = JSON.stringify(sink[level].mock.calls);
      expect(output).not.toContain(secret);
      expect(output).not.toContain('eyJhbGci');
      expect(output).toContain('[REDACTED]');
      logger[level]('Configuración validada.', 'Bootstrap');
      expect(sink[level]).toHaveBeenLastCalledWith({
        service: 'pricing-svc',
        environment: 'test',
        message: 'Configuración validada.',
        context: ['Bootstrap'],
      });
    },
  );
});
