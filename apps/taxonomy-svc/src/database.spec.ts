import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database, readDatabaseConfig } from './database.js';

describe('taxonomy PostgreSQL configuration and lifecycle', () => {
  const directory = mkdtempSync(join(tmpdir(), 'g6-taxonomy-'));
  const ca = join(directory, 'ca.crt');
  const env = {
    PGHOST: 'db.example.test',
    PGPORT: '5432',
    PGDATABASE: 'postgres',
    PGUSER: 'taxonomy_dev_login.project',
    PGPASSWORD: 'only-a-test-password',
    PGSSLMODE: 'verify-full',
    PGSSLROOTCERT: ca,
    G6_DATABASE_SCHEMA: 'taxonomy',
    G6_EXPECTED_ROLE: 'taxonomy_dev_login',
    G6_CONNECTION_MODE: 'session',
  };
  beforeAll(() =>
    writeFileSync(
      ca,
      '-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----',
    ),
  );
  afterAll(() => rmSync(directory, { recursive: true, force: true }));
  afterEach(() => vi.unstubAllEnvs());
  it('uses CA, strict TLS, hostname and bounded pool', () => {
    const config = readDatabaseConfig({ ...env, G6_CONNECT_HOST: '127.0.0.2' });
    expect(config.host).toBe('127.0.0.2');
    expect(config.ssl).toMatchObject({
      rejectUnauthorized: true,
      servername: 'db.example.test',
    });
    expect(config.max).toBe(4);
    expect(config.connectionTimeoutMillis).toBe(10000);
  });
  it.each(Object.keys(env))(
    'rejects missing %s without leaking values',
    (key) => {
      expect(() => readDatabaseConfig({ ...env, [key]: '' })).toThrow(
        'Configuración PostgreSQL taxonomy inválida',
      );
    },
  );
  it.each([
    { PGSSLMODE: 'require' },
    { PGPORT: '0' },
    { PGPORT: '65536' },
    { PGPORT: '1x' },
    { G6_DATABASE_SCHEMA: 'other' },
    { G6_EXPECTED_ROLE: 'postgres', PGUSER: 'postgres' },
    { PGUSER: 'other_dev_login' },
    { G6_CONNECTION_MODE: 'transaction' },
    { PGSSLROOTCERT: 'relative.crt' },
  ])('rejects unsafe configuration %j', (override) => {
    expect(() => readDatabaseConfig({ ...env, ...override })).toThrow(
      'Configuración PostgreSQL taxonomy inválida',
    );
  });
  it('closes pool and rejects use after shutdown', async () => {
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    const database = new Database();
    expect(await database.read(async () => 'no-connection-opened')).toBe(
      'no-connection-opened',
    );
    await database.onModuleDestroy();
    await expect(database.read(async () => true)).rejects.toMatchObject({
      status: 503,
    });
  });
  it('sanitizes driver/callback failures', async () => {
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    const database = new Database();
    try {
      await expect(
        database.read(async () => {
          throw new Error('private-password SELECT query');
        }),
      ).rejects.toMatchObject({
        status: 503,
        message: 'Servicio temporalmente no disponible',
      });
    } finally {
      await database.onModuleDestroy();
    }
  });
});
