import { CatalogConfig } from './config.js';
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const validEnv = {
  NODE_ENV: 'test',
  CATALOG_SVC_PORT: '3001',
  DATABASE_URL:
    'postgresql://catalog_app:fixture-secret@localhost:5432/postgres',
};

describe('CatalogConfig', () => {
  it('accepts and freezes typed configuration', () => {
    const config = new CatalogConfig(validEnv);
    expect(config.port).toBe(3001);
    expect(config.environment).toBe('test');
    expect(Object.isFrozen(config)).toBe(true);
  });

  it('uses PORT only when the service port is absent', () => {
    expect(
      new CatalogConfig({
        ...validEnv,
        CATALOG_SVC_PORT: undefined,
        PORT: '4000',
      }).port,
    ).toBe(4000);
    expect(new CatalogConfig({ ...validEnv, PORT: '4000' }).port).toBe(3001);
  });

  it.each(['NODE_ENV', 'CATALOG_SVC_PORT', 'DATABASE_URL'])(
    'rejects missing %s',
    (key) => {
      expect(
        () => new CatalogConfig({ ...validEnv, [key]: undefined }),
      ).toThrow(key);
    },
  );

  it.each(['', '0', '65536', '-1', '3.5', '1e3', '0x100', ' 3001', 'secret'])(
    'rejects malformed port %s',
    (port) => {
      expect(
        () => new CatalogConfig({ ...validEnv, CATALOG_SVC_PORT: port }),
      ).toThrow('CATALOG_SVC_PORT');
    },
  );

  it.each([
    '',
    'https://localhost/db',
    'postgres://localhost',
    'postgres://localhost:99999/db',
    'postgres://local host/db',
  ])('rejects malformed database URL', (url) => {
    expect(() => new CatalogConfig({ ...validEnv, DATABASE_URL: url })).toThrow(
      'DATABASE_URL',
    );
  });

  it('rejects an unknown environment without echoing values', () => {
    expect(
      () =>
        new CatalogConfig({
          NODE_ENV: 'private-secret',
          CATALOG_SVC_PORT: 'private-secret',
          DATABASE_URL: 'private-secret',
        }),
    ).toThrow(/NODE_ENV/);
    try {
      new CatalogConfig({ DATABASE_URL: 'private-secret' });
    } catch (error) {
      expect(String(error)).not.toContain('private-secret');
    }
  });
});

describe('Session Pooler configuration', () => {
  let directory: string;
  let certificate: string;
  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), 'catalog-config-'));
    certificate = join(directory, 'fixture.crt');
    writeFileSync(certificate, 'public-certificate-fixture');
  });
  afterAll(() => {
    unlinkSync(certificate);
    rmdirSync(directory);
  });
  const pgEnv = () => ({
    NODE_ENV: 'test',
    CATALOG_SVC_PORT: '3001',
    PGHOST: 'localhost',
    PGPORT: '5432',
    PGDATABASE: 'postgres',
    PGUSER: 'catalog_dev_login',
    PGPASSWORD: 'fixture-secret',
    PGSSLMODE: 'verify-full',
    PGSSLROOTCERT: certificate,
    G6_CONNECTION_MODE: 'session',
    G6_DATABASE_SCHEMA: 'catalog',
  });

  it('accepts PG variables with an explicit CA and own schema', () => {
    const config = new CatalogConfig(pgEnv());
    expect(config.database).toMatchObject({
      mode: 'session',
      port: 5432,
      ca: 'public-certificate-fixture',
    });
    expect(Object.isFrozen(config.database)).toBe(true);
  });

  it.each([
    'PGHOST',
    'PGPORT',
    'PGDATABASE',
    'PGUSER',
    'PGPASSWORD',
    'PGSSLMODE',
    'PGSSLROOTCERT',
    'G6_CONNECTION_MODE',
    'G6_DATABASE_SCHEMA',
  ])('rejects missing %s', (key) => {
    expect(() => new CatalogConfig({ ...pgEnv(), [key]: undefined })).toThrow(
      key,
    );
  });

  it.each([
    ['PGSSLMODE', 'disable'],
    ['G6_CONNECTION_MODE', 'transaction'],
    ['G6_DATABASE_SCHEMA', 'taxonomy'],
    ['PGPORT', '1e3'],
    ['PGHOST', 'invalid host'],
    ['PGSSLROOTCERT', 'relative.crt'],
    ['PGSSLROOTCERT', join(tmpdir(), 'catalog-missing-fixture.crt')],
  ])('rejects invalid %s without exposing values', (key, value) => {
    expect(() => new CatalogConfig({ ...pgEnv(), [key]: value })).toThrow(key);
  });

  it('does not fall back to DATABASE_URL for partial PG settings', () => {
    expect(
      () =>
        new CatalogConfig({
          ...validEnv,
          PGSSLMODE: 'disable',
          PGPASSWORD: 'fixture-secret',
        }),
    ).toThrow('PGHOST');
  });
});
