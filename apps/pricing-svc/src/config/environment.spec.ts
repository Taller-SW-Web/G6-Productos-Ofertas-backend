import { InvalidPricingConfig, validateEnvironment } from './environment.js';

const valid = {
  NODE_ENV: 'test',
  PRICING_SVC_PORT: '3002',
  DATABASE_URL: 'postgresql://pricing:fixture-password@127.0.0.1:5432/fixture',
};

describe('Pricing configuration', () => {
  it('acepta configuración válida y prioriza el puerto propio', () => {
    expect(validateEnvironment({ ...valid, PORT: '3000' })).toEqual({
      nodeEnv: 'test',
      port: 3002,
      databaseUrl: valid.DATABASE_URL,
    });
    expect(
      validateEnvironment({
        ...valid,
        PRICING_SVC_PORT: undefined,
        PORT: '4002',
      }).port,
    ).toBe(4002);
  });

  it.each(['NODE_ENV', 'PRICING_SVC_PORT', 'DATABASE_URL'])(
    'rechaza %s ausente o vacía',
    (name) => {
      for (const value of [undefined, '', ' ']) {
        expect(() => validateEnvironment({ ...valid, [name]: value })).toThrow(
          InvalidPricingConfig,
        );
      }
    },
  );

  it.each([
    '0',
    '65536',
    '-1',
    '1.2',
    'NaN',
    '3e3',
    '0xbb8',
    ' 3002',
    'fixture-secret',
  ])('rechaza puerto %s sin exponer su valor', (port) => {
    expect(() =>
      validateEnvironment({ ...valid, PRICING_SVC_PORT: port, PORT: '3000' }),
    ).toThrow('PRICING_SVC_PORT (o PORT) debe ser un entero entre 1 y 65535.');
  });

  it.each([
    'fixture-secret',
    'https://user:fixture-secret@host/db',
    'postgresql:///db',
    'postgresql://user:fixture-secret@host',
    'postgresql://host/db',
    'postgresql://user@host:0/db',
    'postgresql://user@host:65536/db',
    'postgresql://user@host:abc/db',
    'postgresql://user@host/db#fixture-secret',
    'postgresql://user@host/ ',
  ])('rechaza una URL malformada sin reflejar credenciales (%#)', (url) => {
    expect(() => validateEnvironment({ ...valid, DATABASE_URL: url })).toThrow(
      'DATABASE_URL debe incluir host, usuario y base PostgreSQL válidos.',
    );
  });

  it('rechaza un entorno desconocido sin reflejarlo', () => {
    expect(() =>
      validateEnvironment({ ...valid, NODE_ENV: 'fixture-secret' }),
    ).toThrow('NODE_ENV debe ser development, test o production.');
  });
});
