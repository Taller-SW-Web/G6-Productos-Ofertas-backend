import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { CatalogPersistenceError } from '../src/database-errors.js';
import { Database, readPostgresSettings } from '../src/database.js';
import { CatalogTransactionManager } from '../src/catalog-transaction.js';
import { PostgresCatalogWriteRepository } from '../src/postgres-catalog-write.repository.js';
import {
  products,
  skuIdentity,
  skuPhysicalProfiles,
} from '../src/catalog.schema.js';

const dockerAvailable =
  spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], {
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true,
  }).status === 0 &&
  spawnSync('openssl', ['version'], {
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true,
  }).status === 0;

function command(executable: string, args: string[], input?: string): string {
  const result = spawnSync(executable, args, {
    encoding: 'utf8',
    input,
    timeout: 120000,
    windowsHide: true,
  });
  if (result.error || result.status !== 0)
    throw new Error(
      basename(executable) + ' failed in isolated catalog PostgreSQL setup',
    );
  return result.stdout.trim();
}

function sanitizedPostgresLogs(container: string): string {
  const result = spawnSync('docker', ['logs', '--tail', '80', container], {
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true,
  });
  const diagnostics = (result.stdout + '\n' + result.stderr)
    .split(/\r?\n/)
    .filter((line) =>
      /database system is ready to accept connections|starting PostgreSQL|permission denied|private key|server certificate|could not (?:open|read|load).*?(?:certificate|key)|fatal:/i.test(
        line,
      ),
    )
    .map((line) => {
      if (
        /permission denied|private key|server certificate|could not/i.test(line)
      )
        return '[PostgreSQL startup] TLS certificate/key access diagnostic';
      if (/ready to accept connections/i.test(line))
        return '[PostgreSQL startup] ready to accept connections';
      if (/fatal:/i.test(line))
        return '[PostgreSQL startup] fatal server error';
      return '[PostgreSQL startup] server starting';
    });
  const uniqueDiagnostics = [...new Set(diagnostics)].slice(-20);
  return uniqueDiagnostics.length
    ? uniqueDiagnostics.join('\n')
    : 'No sanitized startup diagnostics were emitted.';
}

async function until(check: () => boolean, timeout = 30000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (check()) return;
    await pause(200);
  }
  throw new Error('Isolated PostgreSQL did not become available in time');
}

describe.skipIf(!dockerAvailable)(
  'Catalog persistence on isolated PostgreSQL 17',
  () => {
    const container = 'catalog-persistence-' + process.pid + '-' + Date.now();
    let directory = '';
    let caFile = '';
    let port = '';
    let database: Database;
    let transactions: CatalogTransactionManager;
    const repository = new PostgresCatalogWriteRepository();
    let closed = false;

    const ready = () =>
      spawnSync(
        'docker',
        ['exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres'],
        {
          timeout: 5000,
          windowsHide: true,
          stdio: 'ignore',
        },
      ).status === 0;

    beforeAll(async () => {
      directory = mkdtempSync(join(tmpdir(), 'catalog-persistence-'));
      const certDirectory = join(directory, 'certs');
      mkdirSync(certDirectory);
      chmodSync(certDirectory, 0o755);
      const cert = join(certDirectory, 'server.crt');
      const key = join(certDirectory, 'server.key');
      caFile = cert;
      command('openssl', [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-subj',
        '/CN=localhost',
        '-addext',
        'subjectAltName=DNS:localhost,IP:127.0.0.1',
        '-keyout',
        key,
        '-out',
        cert,
      ]);
      chmodSync(key, 0o644);
      chmodSync(cert, 0o644);
      command('docker', [
        'run',
        '--detach',
        '--name',
        container,
        '--publish',
        '127.0.0.1::5432',
        '--env',
        'POSTGRES_PASSWORD=isolated-admin-password',
        '--volume',
        certDirectory + ':/certs:ro',
        '--entrypoint',
        'sh',
        'postgres:17-alpine',
        '-c',
        'cp /certs/server.key /tmp/server.key; chown postgres:postgres /tmp/server.key; chmod 600 /tmp/server.key; exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/certs/server.crt -c ssl_key_file=/tmp/server.key',
      ]);
      try {
        await until(ready);
      } catch {
        throw new Error(
          'Isolated PostgreSQL did not become available in time. Sanitized container logs:\n' +
            sanitizedPostgresLogs(container),
        );
      }

      const migration = readFileSync(
        resolve('apps/catalog-svc/test/fixtures/0001_create_catalog.sql'),
        'utf8',
      );
      command(
        'docker',
        [
          'exec',
          '-i',
          container,
          'psql',
          '-U',
          'postgres',
          '-v',
          'ON_ERROR_STOP=1',
        ],
        `CREATE ROLE po_catalog_owner NOLOGIN;\nCREATE ROLE catalog_app LOGIN PASSWORD 'isolated-runtime-password';\nCREATE SCHEMA catalog AUTHORIZATION po_catalog_owner;\nCREATE SCHEMA foreign_context;\nCREATE TABLE foreign_context.private_probe (value text);\nINSERT INTO foreign_context.private_probe VALUES ('isolated');\nSET ROLE po_catalog_owner;\n${migration}`,
      );
      port = command('docker', ['port', container, '5432/tcp'])
        .split(':')
        .at(-1)!;
      const env: NodeJS.ProcessEnv = {
        NODE_ENV: 'test',
        PGHOST: 'localhost',
        G6_CONNECT_HOST: '127.0.0.1',
        PGPORT: port,
        PGDATABASE: 'postgres',
        PGUSER: 'catalog_app',
        PGPASSWORD: 'isolated-runtime-password',
        PGSSLMODE: 'verify-full',
        PGSSLROOTCERT: caFile,
        G6_DATABASE_SCHEMA: 'catalog',
        G6_EXPECTED_ROLE: 'catalog_app',
        G6_CONNECTION_MODE: 'direct',
      };
      database = new Database(readPostgresSettings(env));
      transactions = new CatalogTransactionManager(database);
      await database.verifyIdentity();
    }, 180000);

    afterAll(async () => {
      if (!closed) await database?.onModuleDestroy();
      spawnSync('docker', ['rm', '--force', container], {
        timeout: 15000,
        windowsHide: true,
        stdio: 'ignore',
      });
      if (directory) {
        const withinTemp = relative(tmpdir(), directory);
        if (
          !withinTemp ||
          withinTemp.startsWith('..') ||
          isAbsolute(withinTemp)
        )
          throw new Error('Invalid isolated test cleanup path');
        rmSync(directory, { recursive: true, force: true });
      }
    }, 30000);

    function productInput(sku: string) {
      return {
        nombre: 'Persistence fixture',
        descripcion: 'Disposable integration fixture',
        categoria_id: 'category-fixture',
        tipo_producto_id: 'type-fixture',
        marca_id: 'brand-fixture',
        sku_base: sku,
        slug: 'fixture-' + randomUUID(),
        tiene_variantes: false,
      };
    }

    it('persists a product, trigger-created SKU identity, and exact numeric profile values', async () => {
      const sku = 'SKU-' + randomUUID();
      const product = await transactions.run(async (tx) => {
        const row = await repository.insertProduct(tx, productInput(sku));
        const identity = await repository.findSkuIdentity(tx, sku);
        if (!identity) throw new Error('Trigger-created SKU identity missing');
        await repository.insertPhysicalProfile(tx, {
          sku_identity_id: identity.id,
          peso_kg: '12345678901234567890.123456789',
          largo_cm: '1.25',
          ancho_cm: '2.50',
          alto_cm: '3.75',
        });
        return row;
      });
      const profile = await database.read((db) =>
        db
          .select({ peso_kg: skuPhysicalProfiles.peso_kg })
          .from(skuPhysicalProfiles)
          .innerJoin(
            skuIdentity,
            sql`${skuIdentity.id} = ${skuPhysicalProfiles.sku_identity_id}`,
          )
          .where(sql`${skuIdentity.sku} = ${sku}`),
      );
      expect(product.id).toBeTruthy();
      expect(profile[0]?.peso_kg).toBe('12345678901234567890.123456789');
    });

    it('rolls back operation failures and reports deferred aggregate constraints at commit', async () => {
      const rolledBackSku = 'SKU-' + randomUUID();
      const rollbackFailure = new Error('force rollback');
      await expect(
        transactions.run(async (tx) => {
          await repository.insertProduct(tx, productInput(rolledBackSku));
          throw rollbackFailure;
        }),
      ).rejects.toBe(rollbackFailure);
      const [missing] = await database.read((db) =>
        db
          .select({ id: products.id })
          .from(products)
          .where(sql`${products.sku_base} = ${rolledBackSku}`),
      );
      expect(missing).toBeUndefined();

      const deferredSku = 'SKU-' + randomUUID();
      await expect(
        transactions.run(async (tx) => {
          await repository.insertProduct(tx, {
            ...productInput(deferredSku),
            estado: 'ACTIVO',
          });
        }),
      ).rejects.toMatchObject({ failure: 'deferred_constraint' });
    });

    it('classifies unique, foreign-key, and check violations without exposing driver text', async () => {
      const sku = 'SKU-' + randomUUID();
      const parent = await transactions.run(async (tx) => {
        return repository.insertProduct(tx, productInput(sku));
      });
      await expect(
        transactions.run(async (tx) => {
          await repository.insertProduct(tx, productInput(sku));
        }),
      ).rejects.toMatchObject({ failure: 'unique' });
      await expect(
        transactions.run(async (tx) => {
          await repository.insertVariant(tx, {
            product_id: parent.id,
            sku,
            identifying_key: { size: { value_id: 'M' } },
          });
        }),
      ).rejects.toMatchObject({ failure: 'unique' });
      await expect(
        transactions.run(async (tx) => {
          await repository.insertVariant(tx, {
            product_id: randomUUID(),
            sku: 'SKU-' + randomUUID(),
            identifying_key: { size: { value_id: 'M' } },
          });
        }),
      ).rejects.toMatchObject({ failure: 'foreign_key' });
      await expect(
        transactions.run(async (tx) => {
          await repository.insertProduct(tx, {
            ...productInput(''),
            nombre: '',
          });
        }),
      ).rejects.toMatchObject({ failure: 'check' });
      await expect(
        database.read((db) =>
          db.execute(sql`SELECT 'INVALID'::catalog.estado_producto`),
        ),
      ).rejects.toMatchObject({ failure: 'other' });
    });

    it('serializes concurrent SKU reservations through PostgreSQL uniqueness', async () => {
      const sku = 'SKU-' + randomUUID();
      const attempts = await Promise.allSettled([
        transactions.run(async (tx) => {
          await repository.insertProduct(tx, productInput(sku));
        }),
        transactions.run(async (tx) => {
          await repository.insertProduct(tx, productInput(sku));
        }),
      ]);
      expect(
        attempts.filter((attempt) => attempt.status === 'fulfilled'),
      ).toHaveLength(1);
      expect(
        attempts.filter(
          (attempt) =>
            attempt.status === 'rejected' &&
            attempt.reason instanceof CatalogPersistenceError &&
            attempt.reason.failure === 'unique',
        ),
      ).toHaveLength(1);
    });

    it('enforces runtime ownership, denies cross-schema access, and closes its pool', async () => {
      const roles = await database.read((db) =>
        db.execute(sql`
      SELECT r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb,
             has_schema_privilege(current_user, 'catalog', 'USAGE') AS catalog_usage
      FROM pg_roles r WHERE r.rolname = current_user
    `),
      );
      expect(roles.rows[0]).toMatchObject({
        rolsuper: false,
        rolbypassrls: false,
        rolcreaterole: false,
        rolcreatedb: false,
        catalog_usage: true,
      });
      await expect(
        database.read((db) =>
          db.execute(sql`SELECT value FROM foreign_context.private_probe`),
        ),
      ).rejects.toMatchObject({ failure: 'other' });
      await expect(
        database.read((db) =>
          db.execute(sql`CREATE TABLE public.catalog_forbidden (id integer)`),
        ),
      ).rejects.toMatchObject({ failure: 'other' });
      await database.onModuleDestroy();
      closed = true;
      await expect(database.read(async () => true)).rejects.toMatchObject({
        status: 503,
      });
    });
  },
);
