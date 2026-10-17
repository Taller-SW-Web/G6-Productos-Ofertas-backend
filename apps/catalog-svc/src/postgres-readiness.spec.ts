import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CatalogConfig } from './config.js';
import { PostgresReadiness, postgresOptions } from './postgres-readiness.js';

const driver = vi.hoisted(() => ({
  connect: vi.fn(),
  query: vi.fn(),
  end: vi.fn(),
  options: vi.fn(),
}));
vi.mock('pg', () => ({
  Client: class {
    constructor(options: unknown) {
      driver.options(options);
    }
    on() {
      return this;
    }
    connect = driver.connect;
    query = driver.query;
    end = driver.end;
  },
}));

const config = () =>
  new CatalogConfig({
    NODE_ENV: 'test',
    CATALOG_SVC_PORT: '3001',
    DATABASE_URL: 'postgres://catalog_app:fixture-secret@localhost/postgres',
  });
const validStatus = {
  role: 'catalog_app',
  database: 'postgres',
  can_use_schema: true,
  can_create_objects: false,
};

describe('PostgresReadiness', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    driver.connect.mockResolvedValue(undefined);
    driver.query.mockResolvedValue({ rows: [validStatus] });
    driver.end.mockResolvedValue(undefined);
  });

  it('executes only the own-schema read-only query and closes the connection', async () => {
    await new PostgresReadiness(config()).check();
    expect(driver.connect).toHaveBeenCalledOnce();
    expect(driver.query).toHaveBeenCalledOnce();
    expect(driver.query.mock.calls[0][0]).toMatch(/^SELECT/);
    expect(driver.query.mock.calls[0][0]).toContain("'catalog'");
    expect(driver.end).toHaveBeenCalledOnce();
    expect(driver.options).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionTimeoutMillis: 1000,
        query_timeout: 1000,
        statement_timeout: 1000,
      }),
    );
  });

  it.each([
    { ...validStatus, can_use_schema: false },
    { ...validStatus, can_create_objects: true },
    { ...validStatus, role: 'taxonomy_dev_login' },
    { ...validStatus, database: 'other' },
    undefined,
  ])(
    'rejects insufficient or unexpected database identity/permissions',
    async (status) => {
      driver.query.mockResolvedValue({ rows: status ? [status] : [] });
      await expect(new PostgresReadiness(config()).check()).rejects.toThrow(
        'readiness failed',
      );
      expect(driver.end).toHaveBeenCalledOnce();
    },
  );

  it.each(['connect', 'query'] as const)(
    'closes after a %s failure',
    async (method) => {
      driver[method].mockRejectedValue(new Error('fixture-driver-failure'));
      await expect(new PostgresReadiness(config()).check()).rejects.toThrow();
      expect(driver.end).toHaveBeenCalledOnce();
    },
  );

  it('does not retain a previous success after dependency loss', async () => {
    const readiness = new PostgresReadiness(config());
    await readiness.check();
    driver.connect.mockRejectedValue(new Error('fixture-disconnection'));
    await expect(readiness.check()).rejects.toThrow();
    expect(driver.connect).toHaveBeenCalledTimes(2);
  });

  it('requires CA and hostname verification for Session Pooler and checks the base role', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'catalog-pg-'));
    const certificate = join(directory, 'fixture.crt');
    writeFileSync(certificate, 'fixture-ca');
    try {
      const session = new CatalogConfig({
        NODE_ENV: 'test',
        CATALOG_SVC_PORT: '3001',
        PGHOST: 'pooler.example.test',
        PGPORT: '5432',
        PGDATABASE: 'postgres',
        PGUSER: 'catalog_dev_login.fixture-project',
        PGPASSWORD: 'fixture-secret',
        PGSSLMODE: 'verify-full',
        PGSSLROOTCERT: certificate,
        G6_CONNECTION_MODE: 'session',
        G6_DATABASE_SCHEMA: 'catalog',
      });
      expect(postgresOptions(session).ssl).toEqual({
        ca: 'fixture-ca',
        rejectUnauthorized: true,
        servername: 'pooler.example.test',
      });
      driver.query.mockResolvedValue({
        rows: [{ ...validStatus, role: 'catalog_dev_login' }],
      });
      await new PostgresReadiness(session).check();
    } finally {
      unlinkSync(certificate);
      rmdirSync(directory);
    }
  });
});
