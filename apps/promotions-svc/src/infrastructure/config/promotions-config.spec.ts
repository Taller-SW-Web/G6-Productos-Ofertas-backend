import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createEnvironmentFixture } from '../../../test/support/environment.js';
import {
  PromotionsConfigService,
  PromotionsConfigurationError,
  readPromotionsEnvironment,
  validatePromotionsConfiguration,
} from './promotions-config.js';

describe('Promotions configuration', () => {
  const fixture = createEnvironmentFixture();
  afterAll(() => fixture.cleanup());
  it('requires a paired HTTPS issuer/JWKS configuration and does not serialize it', () => {
    for (const auth of [
      { AUTH_ISSUER: 'https://issuer.test' },
      { AUTH_JWKS_URL: 'https://issuer.test/jwks' },
      { AUTH_ISSUER: '', AUTH_JWKS_URL: '' },
      {
        AUTH_ISSUER: 'http://issuer.test',
        AUTH_JWKS_URL: 'https://issuer.test/jwks',
      },
      {
        AUTH_ISSUER: 'https://issuer.test',
        AUTH_JWKS_URL: 'https://user:secret@issuer.test/jwks',
      },
      {
        AUTH_ISSUER: 'https://issuer.test',
        AUTH_JWKS_URL: 'https://issuer.test/jwks?token=secret',
      },
    ])
      expect(() =>
        validatePromotionsConfiguration({ ...fixture.environment, ...auth }),
      ).toThrow(PromotionsConfigurationError);
    const config = new PromotionsConfigService(
      validatePromotionsConfiguration({
        ...fixture.environment,
        AUTH_ISSUER: 'https://issuer.test',
        AUTH_JWKS_URL: 'https://issuer.test/jwks',
      }),
    );
    expect(config.settings.auth?.issuer).toBe('https://issuer.test');
    expect(JSON.stringify(config)).not.toContain('issuer');
  });

  it('maps the official PostgreSQL variables to immutable typed settings', () => {
    const settings = validatePromotionsConfiguration(fixture.environment);
    expect(settings).toMatchObject({
      environment: 'test',
      port: 3004,
      database: { schema: 'promotions', connectionMode: 'session', port: 5432 },
    });
    expect(Object.isFrozen(settings.database)).toBe(true);
    expect(JSON.stringify(new PromotionsConfigService(settings))).not.toContain(
      'password',
    );
  });

  it('disables probes and coupon runtime unless explicitly enabled', () => {
    const environment = { ...fixture.environment };
    delete environment.PROMOTIONS_DEPENDENCY_PROBES_ENABLED;
    delete environment.PROMOTIONS_COUPON_RUNTIME_ENABLED;
    expect(validatePromotionsConfiguration(environment)).toMatchObject({
      dependencyProbesEnabled: false,
      couponRuntimeEnabled: false,
    });
    expect(
      validatePromotionsConfiguration({
        ...environment,
        PROMOTIONS_DEPENDENCY_PROBES_ENABLED: 'true',
        PROMOTIONS_COUPON_RUNTIME_ENABLED: 'true',
      }),
    ).toMatchObject({
      dependencyProbesEnabled: true,
      couponRuntimeEnabled: true,
    });
  });

  it.each([
    'PROMOTIONS_DEPENDENCY_PROBES_ENABLED',
    'PROMOTIONS_COUPON_RUNTIME_ENABLED',
  ])('rejects ambiguous activation in %s', (name) => {
    for (const value of ['', '1', 'TRUE', ' false '])
      expect(() =>
        validatePromotionsConfiguration({
          ...fixture.environment,
          [name]: value,
        }),
      ).toThrow(name);
  });

  it.each([
    'PGHOST',
    'PGPORT',
    'PGDATABASE',
    'PGUSER',
    'PGPASSWORD',
    'PGSSLMODE',
    'PGSSLROOTCERT',
    'G6_DATABASE_SCHEMA',
    'G6_CONNECTION_MODE',
    'RABBITMQ_URL',
  ])('rejects missing required variable %s', (name) => {
    const environment: NodeJS.ProcessEnv = { ...fixture.environment };
    delete environment[name];
    expect(() => validatePromotionsConfiguration(environment)).toThrow(
      PromotionsConfigurationError,
    );
    try {
      validatePromotionsConfiguration(environment);
    } catch (error) {
      expect(error).toBeInstanceOf(PromotionsConfigurationError);
      expect((error as PromotionsConfigurationError).variables).toContain(name);
    }
  });

  it.each(['', '0', '65536', '3e3', '0xbbc', ' 3004 ', '3004\n', '3004.5'])(
    'rejects malformed HTTP port %j',
    (port) => {
      expect(() =>
        validatePromotionsConfiguration({
          ...fixture.environment,
          PROMOTIONS_SVC_PORT: port,
        }),
      ).toThrow('PROMOTIONS_SVC_PORT');
    },
  );

  it('preserves port precedence and the existing fallback', () => {
    const environment: NodeJS.ProcessEnv = {
      ...fixture.environment,
      PORT: '3200',
    };
    expect(validatePromotionsConfiguration(environment).port).toBe(3004);
    delete environment.PROMOTIONS_SVC_PORT;
    expect(validatePromotionsConfiguration(environment).port).toBe(3200);
    delete environment.PORT;
    expect(validatePromotionsConfiguration(environment).port).toBe(3004);
  });

  it('rejects an unreadable or malformed CA instead of downgrading TLS', () => {
    const path = join(fixture.directory, 'invalid.crt');
    writeFileSync(path, 'not a certificate');
    expect(() =>
      validatePromotionsConfiguration({
        ...fixture.environment,
        PGSSLROOTCERT: path,
      }),
    ).toThrow('PGSSLROOTCERT');
  });

  it.each([
    ['NODE_ENV', 'unknown'],
    ['PGPORT', '0'],
    ['PGHOST', 'postgresql://user:secret@localhost'],
    ['PGHOST', 'localhost\n'],
    ['PGSSLMODE', 'disable'],
    ['PGSSLROOTCERT', 'relative.crt'],
    ['PGSSLROOTCERT', fixture.directory],
    ['PGSSLROOTCERT', join(fixture.directory, 'missing.crt')],
    ['G6_DATABASE_SCHEMA', 'inventory'],
    ['G6_CONNECTION_MODE', 'transaction'],
    ['RABBITMQ_URL', 'https://user:secret@localhost'],
    ['RABBITMQ_URL', 'amqp://localhost:0'],
    ['RABBITMQ_URL', 'amqp://localhost/test\n'],
    ['RABBITMQ_URL', 'amqp://localhost/test?password=secret'],
  ])('rejects invalid %s without echoing its value', (name, value) => {
    try {
      validatePromotionsConfiguration({
        ...fixture.environment,
        [name]: value,
      });
      expect.fail('Expected invalid configuration');
    } catch (error) {
      expect(error).toBeInstanceOf(PromotionsConfigurationError);
      expect((error as Error).message).toContain(name);
      expect((error as Error).message).not.toContain(value);
    }
  });

  it('loads root, service-local and process configuration in that precedence', () => {
    mkdirSync(join(fixture.directory, 'apps/promotions-svc'), {
      recursive: true,
    });
    writeFileSync(join(fixture.directory, '.env'), 'PORT=3100\nPGHOST=root\n');
    writeFileSync(
      join(fixture.directory, 'apps/promotions-svc/.env.local'),
      'PORT=3200\nPGHOST=service\n',
    );
    const processEnvironment = { PGHOST: 'process' };
    expect(
      readPromotionsEnvironment(fixture.directory, processEnvironment),
    ).toEqual({ PORT: '3200', PGHOST: 'process' });
    expect(processEnvironment).toEqual({ PGHOST: 'process' });
  });
});
