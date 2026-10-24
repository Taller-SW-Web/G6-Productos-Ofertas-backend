import { sanitize, SanitizedLogger } from './sanitized-logger.js';

describe('sanitized JSON logger', () => {
  it('redacts nested values, arrays, connection strings, authorization and errors', () => {
    const input = {
      password: 'private-secret',
      nested: [{ accessToken: 'private-secret' }],
      message:
        'postgresql://user:private-secret@host/db Bearer private-secret password=private-secret',
      error: new Error('private-secret'),
    };
    expect(JSON.stringify(sanitize(input))).not.toContain('private-secret');
  });

  it('bounds circular structures', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => JSON.stringify(sanitize(circular))).not.toThrow();
  });

  it('redacts serialized JSON and JWTs', () => {
    expect(String(sanitize('{"token":"private-secret"}'))).not.toContain(
      'private-secret',
    );
    expect(sanitize('eyJhbGciOiJIUzI1NiJ9.payload.signature')).toBe(
      '[redacted-token]',
    );
  });

  it('sanitizes every log level and optional stack/context', () => {
    const lines: string[] = [];
    const logger = new SanitizedLogger('test', ['private-secret'], (line) =>
      lines.push(line),
    );
    for (const level of [
      'log',
      'error',
      'warn',
      'debug',
      'verbose',
      'fatal',
    ] as const) {
      logger[level]('private-secret', 'stack private-secret', {
        cookie: 'private-secret',
      });
    }
    expect(lines).toHaveLength(6);
    for (const line of lines) {
      expect(line).not.toContain('private-secret');
      expect(JSON.parse(line)).toMatchObject({
        service: 'catalog-svc',
        environment: 'test',
      });
    }
  });
});
