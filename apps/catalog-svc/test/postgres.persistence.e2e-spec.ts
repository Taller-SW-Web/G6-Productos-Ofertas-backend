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
import { DisposableCatalogBroker } from './support/disposable-catalog-broker.js';
import { CatalogAmqpRuntime } from '../src/catalog-amqp.js';
import { CatalogTelemetry } from '../src/catalog-telemetry.js';
import { and, eq, sql } from 'drizzle-orm';
import { CatalogMutationService } from '../src/catalog-mutation.service.js';
import type { CatalogMasterClient } from '../src/catalog-master.client.js';
import { CatalogMessageService } from '../src/catalog-message.service.js';
import { CatalogQueryRepository } from '../src/catalog-query.repository.js';
import { activeAttempt, parseCatalogMessage } from '../src/catalog-messages.js';
import type { Attribute } from '../src/commercial.types.js';
import { CatalogPersistenceError } from '../src/database-errors.js';
import {
  Database,
  readPostgresSettings,
  type PostgresSettings,
} from '../src/database.js';
import { CatalogTransactionManager } from '../src/catalog-transaction.js';
import { PostgresCatalogWriteRepository } from '../src/postgres-catalog-write.repository.js';
import { PostgresCatalogRepository } from '../src/postgres-catalog.repository.js';
import {
  products,
  activationChecks,
  outbox,
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
const isCi = process.env.CI?.toLowerCase() === 'true';

if (isCi && !dockerAvailable) {
  throw new Error(
    'Catalog persistence E2E requires Docker and OpenSSL in CI; refusing to skip PostgreSQL coverage',
  );
}

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
    let persistenceSettings: PostgresSettings;
    let transactions: CatalogTransactionManager;
    const repository = new PostgresCatalogWriteRepository();
    let closed = false;
    const jointBroker = new DisposableCatalogBroker();
    let jointRuntime: CatalogAmqpRuntime | undefined;

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
      persistenceSettings = readPostgresSettings(env);
      database = new Database(persistenceSettings);
      transactions = new CatalogTransactionManager(database);
      await database.verifyIdentity();
      await jointBroker.start();
    }, 180000);

    afterAll(async () => {
      await jointRuntime?.onModuleDestroy();
      await jointBroker.close();
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

    it('reads internal demo drafts and their actual variant photos without exposing them through the ordinary active-only query', async () => {
      const marker = 'DEMO-READ-' + randomUUID();
      const parent = await transactions.run(async (tx) => {
        const row = await repository.insertProduct(tx, {
          ...productInput(marker),
          nombre: marker,
          tiene_variantes: true,
        });
        const child = await repository.insertVariant(tx, {
          product_id: row.id,
          sku: marker + '-M',
          identifying_key: { size: { valor_id: 'M' } },
        });
        await repository.insertVariantImage(tx, {
          variant_id: child.id,
          url: 'https://example.test/demo-variant.jpg',
          posicion: 0,
        });
        await repository.insertVariantAttribute(tx, {
          variant_id: child.id,
          caracteristica_id: 'size',
          nombre_snapshot: 'Size',
          valor_id: 'M',
          valor: 'M',
          es_identificador: true,
        });
        return row;
      });
      const reads = new PostgresCatalogRepository(database);
      const query = {
        canal: 'MARKETPLACE' as const,
        q: marker,
        pagina: 1,
        tamanio: 20,
        orden: 'NOMBRE_ASC' as const,
      };
      expect((await reads.listCandidates(query)).items).toHaveLength(0);
      const page = await reads.listCandidates(
        { ...query, estado: 'BORRADOR' },
        undefined,
        true,
      );
      expect(page.total).toBe(1);
      expect(page.items[0]).toMatchObject({
        product_id: parent.id,
        images: ['https://example.test/demo-variant.jpg'],
      });
      expect(
        await reads.findCandidateByProductId(
          parent.id,
          undefined,
          'MARKETPLACE',
          true,
        ),
      ).toMatchObject({
        product_id: parent.id,
        images: ['https://example.test/demo-variant.jpg'],
      });
      expect(
        await reads.findCandidateByProductId(
          parent.id,
          { productIds: [parent.id], variantIds: [] },
          'MARKETPLACE',
        ),
      ).toBeNull();
    });

    it('JOINT-01: commits aggregate/Outbox, transports requested/results through a real broker, deduplicates Inbox and reconnects', async () => {
      // Seed an internal BORRADOR coordination fixture, not a mocked HTTP or Taxonomy flow.
      const correlation = randomUUID(),
        operation = randomUUID(),
        messageId = randomUUID(),
        sku = '000-JOINT-' + randomUUID();
      const product = await transactions.run(async (tx) => {
        const row = await repository.insertProduct(tx, productInput(sku));
        const data = { product_id: row.id, sku, variant_id: null };
        await repository.insertActivationCheck(tx, {
          product_id: row.id,
          sku,
          dependency: 'INVENTORY',
          operation_id: operation,
          correlation_id: correlation,
          state: 'PENDING',
          request_payload: data,
        });
        await repository.insertOutboxMessage(tx, {
          message_id: messageId,
          event_name: 'inventory.sku.initialization.requested',
          kind: 'command',
          correlation_id: correlation,
          operation_id: operation,
          occurred_at: new Date(),
          payload: data,
        });
        return row;
      });
      const signals = new CatalogTelemetry();
      jointRuntime = new CatalogAmqpRuntime(
        new CatalogMessageService(database, signals),
        jointBroker.settings,
      );
      jointRuntime.onModuleInit();
      const requested = await jointBroker.next('po.inventory.q');
      expect(JSON.parse(requested.content.toString()).message_id).toBe(
        messageId,
      );
      const result = {
        message_id: randomUUID(),
        schema_version: 1,
        occurred_at: new Date().toISOString(),
        correlation_id: correlation,
        operation_id: operation,
        causation_id: messageId,
        producer: 'inventory-svc',
        kind: 'result',
        name: 'inventory.sku.initialization.completed',
        data: {
          product_id: product.id,
          sku,
          variant_id: null,
          status: 'INITIALIZED',
          completed_at: new Date().toISOString(),
        },
      };
      await jointBroker.result('inventory', result);
      async function completed() {
        const [row] = await database.read((db) =>
          db
            .select()
            .from(activationChecks)
            .where(eq(activationChecks.operation_id, operation)),
        );
        return row.state === 'COMPLETED';
      }
      const deadline = Date.now() + 15000;
      while (!(await completed())) {
        if (Date.now() > deadline)
          throw new Error('Joint result not committed');
        await pause(50);
      }
      await jointBroker.result('inventory', result);
      const replayDeadline = Date.now() + 15000;
      while (!signals.snapshot().INBOX_DUPLICATE) {
        if (Date.now() > replayDeadline)
          throw new Error('Joint replay not processed');
        await pause(50);
      }
      const seen = await database.read((db) =>
        db.execute(
          sql`SELECT count(*)::int AS n FROM catalog.inbox WHERE message_id=${result.message_id}`,
        ),
      );
      expect(seen.rows[0]?.n).toBe(1);
      const [published] = await database.read((db) =>
        db.select().from(outbox).where(eq(outbox.message_id, messageId)),
      );
      expect(published.published_at).not.toBeNull();
      jointBroker.stop();
      const followupId = randomUUID();
      await transactions.run(async (tx) => {
        const pending = await repository.insertProduct(
          tx,
          productInput('AFTER-OUTAGE-' + randomUUID()),
        );
        const nextOperation = randomUUID(),
          data = {
            product_id: pending.id,
            sku: pending.sku_base,
            variant_id: null,
          };
        await repository.insertActivationCheck(tx, {
          product_id: pending.id,
          sku: pending.sku_base,
          dependency: 'INVENTORY',
          operation_id: nextOperation,
          correlation_id: correlation,
          state: 'PENDING',
          request_payload: data,
        });
        return repository.insertOutboxMessage(tx, {
          message_id: followupId,
          event_name: 'inventory.sku.initialization.requested',
          kind: 'command',
          correlation_id: correlation,
          operation_id: nextOperation,
          occurred_at: new Date(),
          payload: data,
        });
      });
      const [pending] = await database.read((db) =>
        db.select().from(outbox).where(eq(outbox.message_id, followupId)),
      );
      expect(pending.published_at).toBeNull();
      await jointBroker.resume();
      expect(
        JSON.parse(
          (await jointBroker.next('po.inventory.q')).content.toString(),
        ).message_id,
      ).toBe(followupId);
      await jointRuntime.onModuleDestroy();
      jointRuntime = undefined;
    }, 90000);

    it('PG-FAULT-01: statement timeout rolls back the transaction and the same pool recovers', async () => {
      const sku = 'TIMEOUT-' + randomUUID();
      await expect(
        transactions.run(async (tx) => {
          await repository.insertProduct(tx, productInput(sku));
          await tx.execute(sql`SET LOCAL statement_timeout='20ms'`);
          await tx.execute(sql`SELECT pg_sleep(0.1)`);
        }),
      ).rejects.toMatchObject({ failure: 'connection', sqlState: '57014' });
      expect(
        await database.read((db) =>
          db.select().from(products).where(eq(products.sku_base, sku)),
        ),
      ).toHaveLength(0);
      await expect(database.verifyIdentity()).resolves.toBeUndefined();
    });

    it('PG-FAULT-02: pool saturation times out safely and the same test pool recovers after release', async () => {
      // Dedicated small pool only in this fault-injection test; same disposable PG instance.
      const saturated = new Database({
        ...persistenceSettings,
        pool: {
          ...persistenceSettings.pool,
          max: 1,
          connectionTimeoutMillis: 1000,
        },
      });
      let release!: () => void, ready!: () => void;
      const gate = new Promise<void>((resolve) => {
          release = resolve;
        }),
        acquired = new Promise<void>((resolve) => {
          ready = resolve;
        });
      const blocker = saturated.transaction(async () => {
        ready();
        await gate;
      });
      try {
        await acquired;
        await expect(saturated.verifyIdentity()).rejects.toMatchObject({
          failure: 'connection',
        });
        release();
        await blocker;
        await expect(saturated.verifyIdentity()).resolves.toBeUndefined();
      } finally {
        release();
        await blocker;
        await saturated.onModuleDestroy();
      }
    });

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
      const notNullError = await transactions
        .run(async (tx) => {
          await tx.execute(sql`
            UPDATE catalog.products SET nombre = ${null} WHERE id = ${parent.id}
          `);
        })
        .catch((error: unknown) => error);
      expect(notNullError).toMatchObject({
        failure: 'not_null',
        sqlState: '23502',
        message: 'Falló una operación de persistencia de Catálogo',
      });
      expect(JSON.stringify(notNullError)).not.toContain('UPDATE');
      expect(JSON.stringify(notNullError)).not.toContain('catalog.products');
      expect(JSON.stringify(notNullError)).not.toContain(parent.id);
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

    it('validates the DATA-002 batch in disposable PostgreSQL', () => {
      const catalogDirectory = resolve('scripts/seed/mcp/catalog');
      const manifest = JSON.parse(
        readFileSync(
          join(catalogDirectory, '002_manifest_catalogo.json'),
          'utf8',
        ),
      ) as {
        taxonomy: {
          brands: Record<string, string>;
          types: Record<string, string>;
          categories: Record<string, string>;
          characteristics: Record<string, string>;
          values: Record<string, Record<string, string>>;
        };
      };
      const sqlLiteral = (value: string) =>
        "'" + value.replaceAll("'", "''") + "'";
      const rows = (values: string[]) => values.join(',\n');
      const brandRows = Object.entries(manifest.taxonomy.brands).map(
        ([name, id]) => `(${sqlLiteral(id)}, ${sqlLiteral(name)}, 'ACTIVO')`,
      );
      const typeRows = Object.entries(manifest.taxonomy.types).map(
        ([name, id]) => `(${sqlLiteral(id)}, ${sqlLiteral(name)}, 'ACTIVO')`,
      );
      const categoryRows = Object.entries(manifest.taxonomy.categories).map(
        ([name, id]) =>
          `(${sqlLiteral(id)}, ${sqlLiteral(name)}, NULL, 'ACTIVO')`,
      );
      const characteristicRows = Object.entries(
        manifest.taxonomy.characteristics,
      ).map(
        ([name, id]) => `(${sqlLiteral(id)}, ${sqlLiteral(name)}, 'ACTIVO')`,
      );
      const valueRows = Object.entries(manifest.taxonomy.values).flatMap(
        ([characteristic, values]) =>
          Object.entries(values).map(
            ([name, id]) =>
              `(${sqlLiteral(id)}, ${sqlLiteral(manifest.taxonomy.characteristics[characteristic]!)}, ${sqlLiteral(name)}, 'ACTIVO')`,
          ),
      );
      const relationRows = Object.values(manifest.taxonomy.types).flatMap(
        (typeId) =>
          Object.values(manifest.taxonomy.characteristics).map(
            (characteristicId) =>
              `(${sqlLiteral(typeId)}, ${sqlLiteral(characteristicId)}, true, 'ACTIVO')`,
          ),
      );
      const taxonomyFixture = `
        CREATE SCHEMA taxonomy;
        CREATE SCHEMA storage;
        CREATE TYPE taxonomy.estado_entidad AS ENUM ('ACTIVO', 'INACTIVO');
        CREATE TABLE taxonomy.brands (id uuid PRIMARY KEY, nombre text NOT NULL, estado taxonomy.estado_entidad NOT NULL);
        CREATE TABLE taxonomy.product_types (id uuid PRIMARY KEY, nombre text NOT NULL, estado taxonomy.estado_entidad NOT NULL);
        CREATE TABLE taxonomy.categories (id uuid PRIMARY KEY, nombre text NOT NULL, categoria_padre_id uuid, estado taxonomy.estado_entidad NOT NULL);
        CREATE TABLE taxonomy.characteristics (id uuid PRIMARY KEY, nombre text NOT NULL, estado taxonomy.estado_entidad NOT NULL);
        CREATE TABLE taxonomy.characteristic_values (id uuid PRIMARY KEY, caracteristica_id uuid NOT NULL, nombre text NOT NULL, estado taxonomy.estado_entidad NOT NULL);
        CREATE TABLE taxonomy.product_type_characteristics (tipo_producto_id uuid NOT NULL, caracteristica_id uuid NOT NULL, obligatoria boolean NOT NULL, estado taxonomy.estado_entidad NOT NULL);
        CREATE TABLE storage.objects (name text NOT NULL, mime_type text, metadata jsonb, bucket_id text NOT NULL);
        INSERT INTO taxonomy.brands (id, nombre, estado) VALUES ${rows(brandRows)};
        INSERT INTO taxonomy.product_types (id, nombre, estado) VALUES ${rows(typeRows)};
        INSERT INTO taxonomy.categories (id, nombre, categoria_padre_id, estado) VALUES ${rows(categoryRows)};
        INSERT INTO taxonomy.characteristics (id, nombre, estado) VALUES ${rows(characteristicRows)};
        INSERT INTO taxonomy.characteristic_values (id, caracteristica_id, nombre, estado) VALUES ${rows(valueRows)};
        INSERT INTO taxonomy.product_type_characteristics (tipo_producto_id, caracteristica_id, obligatoria, estado) VALUES ${rows(relationRows)};
        GRANT USAGE ON SCHEMA taxonomy TO po_catalog_owner;
        GRANT SELECT ON ALL TABLES IN SCHEMA taxonomy TO po_catalog_owner;
      `;
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
        taxonomyFixture,
      );

      const preflightSql = readFileSync(
        join(catalogDirectory, '001_preflight_readonly.sql'),
        'utf8',
      );
      const runSql = (input: string) =>
        spawnSync(
          'docker',
          [
            'exec',
            '-i',
            container,
            'psql',
            '-X',
            '-q',
            '-U',
            'postgres',
            '-v',
            'ON_ERROR_STOP=1',
          ],
          {
            encoding: 'utf8',
            input,
            timeout: 120000,
            windowsHide: true,
          },
        );
      const preflight = command(
        'docker',
        [
          'exec',
          '-i',
          container,
          'psql',
          '-X',
          '-At',
          '-U',
          'postgres',
          '-v',
          'ON_ERROR_STOP=1',
        ],
        preflightSql,
      );
      expect(preflight).not.toMatch(
        /FALTA_INACTIVA_O_CARACTERISTICA_INCORRECTA|RELACION_FALTA_O_INACTIVA|DATA002_PREFLIGHT_BLOCKED/,
      );

      const batch = readFileSync(
        join(catalogDirectory, '003_carga_catalogo.sql'),
        'utf8',
      );
      const existingProductCount = command('docker', [
        'exec',
        '-i',
        container,
        'psql',
        '-X',
        '-At',
        '-U',
        'postgres',
        '-c',
        'SELECT count(*) FROM catalog.products',
      ]);
      const expectPreflightToBlock = (
        mutation: string,
        restoration: string,
      ) => {
        command(
          'docker',
          [
            'exec',
            '-i',
            container,
            'psql',
            '-X',
            '-q',
            '-U',
            'postgres',
            '-v',
            'ON_ERROR_STOP=1',
          ],
          mutation,
        );
        for (const sqlText of [preflightSql, batch]) {
          const result = runSql(sqlText);
          expect(result.error).toBeUndefined();
          expect(result.status).not.toBe(0);
          expect(result.stderr).toContain('DATA002_PREFLIGHT_BLOCKED');
        }
        expect(
          command('docker', [
            'exec',
            '-i',
            container,
            'psql',
            '-X',
            '-At',
            '-U',
            'postgres',
            '-c',
            'SELECT count(*) FROM catalog.products',
          ]),
        ).toBe(existingProductCount);
        command(
          'docker',
          [
            'exec',
            '-i',
            container,
            'psql',
            '-X',
            '-q',
            '-U',
            'postgres',
            '-v',
            'ON_ERROR_STOP=1',
          ],
          restoration,
        );
      };
      const brandEntry = Object.entries(manifest.taxonomy.brands).find(
        ([, id]) => id === 'd05cc621-2d16-faa3-f620-19fb3173737c',
      );
      expect(brandEntry).toBeDefined();
      expectPreflightToBlock(
        "DELETE FROM taxonomy.brands WHERE id = 'd05cc621-2d16-faa3-f620-19fb3173737c';",
        `INSERT INTO taxonomy.brands (id, nombre, estado) VALUES (${sqlLiteral(brandEntry![1])}, ${sqlLiteral(brandEntry![0])}, 'ACTIVO');`,
      );
      expectPreflightToBlock(
        "UPDATE taxonomy.product_types SET estado = 'INACTIVO' WHERE id = 'b023a151-d69f-ff9a-483a-678eefe6842e';",
        "UPDATE taxonomy.product_types SET estado = 'ACTIVO' WHERE id = 'b023a151-d69f-ff9a-483a-678eefe6842e';",
      );
      expectPreflightToBlock(
        "UPDATE taxonomy.product_type_characteristics SET estado = 'INACTIVO' WHERE tipo_producto_id = 'b023a151-d69f-ff9a-483a-678eefe6842e' AND caracteristica_id = 'acee6db1-ba1c-f020-caf8-f439b09556ff';",
        "UPDATE taxonomy.product_type_characteristics SET estado = 'ACTIVO' WHERE tipo_producto_id = 'b023a151-d69f-ff9a-483a-678eefe6842e' AND caracteristica_id = 'acee6db1-ba1c-f020-caf8-f439b09556ff';",
      );
      const executeBatch = () =>
        command(
          'docker',
          [
            'exec',
            '-i',
            container,
            'psql',
            '-X',
            '-q',
            '-U',
            'postgres',
            '-v',
            'ON_ERROR_STOP=1',
          ],
          `SET ROLE po_catalog_owner;\n${batch}`,
        );
      executeBatch();
      executeBatch();

      const postcheck = command(
        'docker',
        [
          'exec',
          '-i',
          container,
          'psql',
          '-X',
          '-At',
          '-F',
          '|',
          '-U',
          'postgres',
          '-v',
          'ON_ERROR_STOP=1',
        ],
        readFileSync(
          join(catalogDirectory, '004_postcheck_readonly.sql'),
          'utf8',
        ),
      );
      const postcheckRows = postcheck
        .split(/\r?\n/)
        .filter((row) => row.length > 0);
      expect(postcheckRows).toHaveLength(12);
      expect(postcheckRows.every((row) => row.endsWith('|PASS'))).toBe(true);
      expect(postcheckRows).toContain('productos|15|15|PASS');
      expect(postcheckRows).toContain('variantes|45|45|PASS');
      expect(postcheckRows).toContain('payloads_jsonb_validos|0|0|PASS');

      const conflict = spawnSync(
        'docker',
        [
          'exec',
          '-i',
          container,
          'psql',
          '-X',
          '-q',
          '-U',
          'postgres',
          '-v',
          'ON_ERROR_STOP=1',
        ],
        {
          encoding: 'utf8',
          input: `UPDATE catalog.products SET descripcion = 'different payload' WHERE id = '96c6972f-2bd2-5528-8028-5293fe719db9';\nSET ROLE po_catalog_owner;\n${batch}`,
          timeout: 120000,
          windowsHide: true,
        },
      );
      expect(conflict.error).toBeUndefined();
      expect(conflict.status).not.toBe(0);
      expect(conflict.stderr).toContain(
        'DATA-002 contenido diferente en catalog.products',
      );
    });

    // These provider tests use authoritative master fixtures, never shared Taxonomy or Supabase writes.
    function mutationService() {
      return new CatalogMutationService(
        transactions,
        repository,
        {
          masters: async () => undefined,
          attributes: async (_type: string, values: Attribute[]) => values,
        } as unknown as CatalogMasterClient,
        {
          resolve: async (_input, id) => ({
            slug: 'fixture-' + id,
            moneda: 'PEN',
          }),
        },
      );
    }
    const actor = {
      authorization: 'Bearer isolated-master-fixture',
      correlationId: randomUUID(),
    };
    const fullProfile = {
      pesoKg: 1.5,
      dimensionesCm: { largo: 10, ancho: 20, alto: 30 },
    };
    function createRequest(hasVariants = false) {
      return {
        nombre: 'Mutation fixture',
        descripcion: 'Disposable',
        categoriaId: 'category-fixture',
        tipoProductoId: 'type-fixture',
        marcaId: 'brand-fixture',
        skuBase: '000-' + randomUUID(),
        tieneVariantes: hasVariants,
        precioBaseInicial: 20,
        imagenes: [{ url: 'https://example.test/product' }],
        ...(hasVariants ? {} : { perfilFisico: fullProfile }),
      };
    }
    async function requested(productId: string) {
      return database.read((db) =>
        db
          .select()
          .from(outbox)
          .where(
            and(
              sql`${outbox.payload}->>'product_id' = ${productId}`,
              sql`${outbox.event_name} IN ('pricing.product.initialization.requested','inventory.sku.initialization.requested')`,
            ),
          ),
      );
    }
    function resultFor(row: typeof outbox.$inferSelect, rejected = false) {
      const pricing = row.event_name.startsWith('pricing.');
      return parseCatalogMessage({
        message_id: randomUUID(),
        schema_version: 1,
        occurred_at: new Date().toISOString(),
        correlation_id: row.correlation_id,
        operation_id: row.operation_id,
        causation_id: row.message_id,
        producer: pricing ? 'pricing-svc' : 'inventory-svc',
        kind: 'result',
        name: row.event_name.replace(
          'requested',
          rejected ? 'rejected' : 'completed',
        ),
        data: {
          product_id: row.payload.product_id,
          ...(pricing
            ? { sku_base: row.payload.sku_base }
            : {
                sku: row.payload.sku,
                variant_id: row.payload.variant_id ?? null,
              }),
          status: rejected ? 'REJECTED' : pricing ? 'READY' : 'INITIALIZED',
          completed_at: new Date().toISOString(),
          code: rejected ? 'FIXTURE_REJECTED' : null,
        },
      });
    }
    async function complete(
      productId: string,
      dependency?: 'pricing' | 'inventory',
    ) {
      const messages = new CatalogMessageService(database);
      for (const row of await requested(productId))
        if (!dependency || row.event_name.startsWith(dependency + '.'))
          await messages.consume(resultFor(row));
    }
    it('creates simple and variant products atomically with the correct preparation and Outbox intents', async () => {
      const service = mutationService(),
        body = createRequest(),
        simple = await service.createProduct(body, actor);
      expect(simple).toMatchObject({
        status: 'BORRADOR',
        sku_base: body.skuBase,
        pricing_preparado: false,
        inventario_inicializado: false,
      });
      expect(
        (await requested(simple.product_id)).map((r) => r.event_name).sort(),
      ).toEqual([
        'inventory.sku.initialization.requested',
        'pricing.product.initialization.requested',
      ]);
      await expect(service.createProduct(body, actor)).rejects.toMatchObject({
        status: 409,
        response: { code: 'SKU_DUPLICADO' },
      });
      const parent = await service.createProduct(createRequest(true), actor);
      expect(
        (await requested(parent.product_id)).map((r) => r.event_name),
      ).toEqual(['pricing.product.initialization.requested']);
      const variantInput = {
        sku: '000-V-' + randomUUID(),
        atributosIdentificadores: [
          {
            caracteristica_id: 'size',
            nombre: 'Size',
            valor_id: 'M',
            valor: 'M',
          },
        ],
        imagenUrl: 'https://example.test/variant',
        perfilFisico: fullProfile,
      };
      const child = await service.createVariant(
        parent.product_id,
        variantInput,
        actor,
      );
      expect(child).toMatchObject({
        sku: variantInput.sku,
        status: 'BORRADOR',
      });
      const rows = await requested(parent.product_id);
      expect(
        rows.filter((r) => r.event_name.startsWith('pricing.')),
      ).toHaveLength(1);
      expect(
        rows.filter(
          (r) =>
            r.payload.variant_id === child.variant_id &&
            r.event_name.startsWith('inventory.'),
        ),
      ).toHaveLength(1);
      await expect(
        service.createVariant(
          parent.product_id,
          { ...variantInput, sku: 'new-' + randomUUID() },
          actor,
        ),
      ).rejects.toMatchObject({
        status: 409,
        response: { code: 'COMBINACION_DUPLICADA' },
      });
      await expect(
        service.createVariant(simple.product_id, variantInput, actor),
      ).rejects.toMatchObject({
        status: 409,
        response: { code: 'PRODUCTO_NO_ADMITE_VARIANTES' },
      });
    });
    it('validates completed preparation and rolls back invalid active edits including versions', async () => {
      const service = mutationService(),
        product = await service.createProduct(createRequest(), actor);
      await expect(
        service.state(product.product_id, undefined, 'activate', {}, actor),
      ).rejects.toMatchObject({ status: 422 });
      await complete(product.product_id);
      expect(
        await service.state(
          product.product_id,
          undefined,
          'activate',
          { catalogVersion: 0 },
          actor,
        ),
      ).toMatchObject({ status: 'ACTIVO', catalog_version: 1 });
      await expect(
        service.update(
          product.product_id,
          undefined,
          { catalogVersion: 0, nombre: 'stale' },
          actor,
        ),
      ).rejects.toMatchObject({
        status: 409,
        response: { code: 'VERSION_CONFLICT' },
      });
      await expect(
        service.update(
          product.product_id,
          undefined,
          { perfilFisico: null, catalogVersion: 1 },
          actor,
        ),
      ).rejects.toMatchObject({ status: 400 });
      const [persisted] = await database.read((db) =>
        db.select().from(products).where(eq(products.id, product.product_id)),
      );
      expect(persisted).toMatchObject({
        estado: 'ACTIVO',
        catalog_version: 1n,
        nombre: 'Mutation fixture',
      });
      expect(
        await service.update(
          product.product_id,
          undefined,
          { descripcion: 'Valid edit', catalogVersion: 1 },
          actor,
        ),
      ).toMatchObject({ status: 'ACTIVO', catalog_version: 2 });
    });
    it('serializes last-variant deactivation and preserves independent parent/child reactivation', async () => {
      const service = mutationService(),
        parent = await service.createProduct(createRequest(true), actor);
      const child = await service.createVariant(
        parent.product_id,
        {
          sku: '000-V-' + randomUUID(),
          atributosIdentificadores: [
            {
              caracteristica_id: 'size',
              nombre: 'Size',
              valor_id: 'L',
              valor: 'L',
            },
          ],
          imagenUrl: 'https://example.test/variant',
          perfilFisico: fullProfile,
        },
        actor,
      );
      await complete(parent.product_id, 'inventory');
      expect(
        await service.state(
          parent.product_id,
          child.variant_id,
          'activate',
          undefined,
          actor,
        ),
      ).toMatchObject({ status: 'ACTIVA' });
      await expect(
        service.state(parent.product_id, undefined, 'activate', {}, actor),
      ).rejects.toMatchObject({ status: 422 });
      await complete(parent.product_id, 'pricing');
      await service.state(parent.product_id, undefined, 'activate', {}, actor);
      await service.state(
        parent.product_id,
        child.variant_id,
        'deactivate',
        undefined,
        actor,
      );
      const snapshot = await transactions.run(async (tx) =>
        repository.aggregate(
          tx,
          (await repository.lockProduct(tx, parent.product_id))!,
        ),
      );
      expect(snapshot.estado).toBe('INACTIVO');
      expect(snapshot.children[0]?.estado).toBe('INACTIVA');
      const events = await database.read((db) =>
        db
          .select()
          .from(outbox)
          .where(sql`${outbox.payload}->>'product_id' = ${parent.product_id}`),
      );
      expect(
        events.filter((e) => e.event_name.endsWith('.deactivated')),
      ).toHaveLength(2);
      await service.state(
        parent.product_id,
        child.variant_id,
        'deactivate',
        undefined,
        actor,
      );
      await service.state(
        parent.product_id,
        child.variant_id,
        'reactivate',
        undefined,
        actor,
      );
      const [stillInactive] = await database.read((db) =>
        db.select().from(products).where(eq(products.id, parent.product_id)),
      );
      expect(stillInactive.estado).toBe('INACTIVO');
      await service.state(
        parent.product_id,
        undefined,
        'reactivate',
        {},
        actor,
      );
      const deactivated = await service.state(
        parent.product_id,
        undefined,
        'deactivate',
        {},
        actor,
      );
      expect(deactivated).toMatchObject({
        status: 'INACTIVO',
        variants: [expect.objectContaining({ status: 'ACTIVA' })],
      });
    });
    it('admits only one manual retry, rejects stale results and keeps COMPLETED terminal with Inbox dedupe', async () => {
      vi.stubEnv('CATALOG_PREPARATION_TIMEOUT_MS', '1');
      try {
        const service = mutationService(),
          product = await service.createProduct(createRequest(), actor),
          messages = new CatalogMessageService(database);
        const original = (await requested(product.product_id)).find((r) =>
          r.event_name.startsWith('inventory.'),
        )!;
        await database.read((db) =>
          db
            .update(outbox)
            .set({ published_at: new Date(Date.now() - 10000) })
            .where(eq(outbox.id, original.id)),
        );
        const attempts = await Promise.allSettled([
          service.retry(
            product.product_id,
            undefined,
            { dependencia: 'INVENTARIO' },
            actor,
          ),
          service.retry(
            product.product_id,
            undefined,
            { dependencia: 'INVENTARIO' },
            actor,
          ),
        ]);
        expect(attempts.filter((a) => a.status === 'fulfilled')).toHaveLength(
          1,
        );
        expect(attempts.find((a) => a.status === 'rejected')).toMatchObject({
          reason: {
            status: 409,
            response: { code: 'PREPARACION_NO_REINTENTABLE' },
          },
        });
        const active = activeAttempt(
          (await requested(product.product_id)).filter(
            (r) => r.operation_id === original.operation_id,
          ),
        )!;
        expect(active.message_id).not.toBe(original.message_id);
        expect(active.operation_id).toBe(original.operation_id);
        expect(await messages.consume(resultFor(original))).toBe('STALE');
        const success = resultFor(active);
        expect(await messages.consume(success)).toBe('APPLIED');
        expect(await messages.consume(success)).toBe('DUPLICATE');
        expect(await messages.consume(resultFor(active, true))).toBe(
          'TERMINAL',
        );
        const [check] = await database.read((db) =>
          db
            .select()
            .from(activationChecks)
            .where(eq(activationChecks.operation_id, original.operation_id!)),
        );
        expect(check.state).toBe('COMPLETED');
        await expect(
          service.retry(
            product.product_id,
            undefined,
            { dependencia: 'INVENTARIO' },
            actor,
          ),
        ).rejects.toMatchObject({ status: 409 });
      } finally {
        vi.unstubAllEnvs();
      }
    });
    it('keeps Outbox pending without confirm and permits parallel relays without claiming one row twice', async () => {
      const service = mutationService(),
        product = await service.createProduct(createRequest(), actor),
        messages = new CatalogMessageService(database);
      // Other tests leave pending records intentionally; a failed relay must preserve its selected immutable envelope.
      expect(
        await messages.relayOne({
          publish: async () => {
            throw new Error('fixture unconfirmed');
          },
        }),
      ).toBe('PENDING');
      const seen = new Set<string>();
      const publish = async (
        message: import('../src/catalog-messages.js').CatalogEnvelope,
      ) => {
        expect(seen.has(message.message_id)).toBe(false);
        seen.add(message.message_id);
      };
      await Promise.all([
        messages.relayOne({ publish }),
        messages.relayOne({ publish }),
      ]);
      expect(seen.size).toBe(2);
      expect((await requested(product.product_id)).length).toBe(2);
    });

    it('reads contractual preparation, variants and physical SKU data from the committed aggregate', async () => {
      const service = mutationService(),
        simpleBody = createRequest(),
        simple = await service.createProduct(simpleBody, actor);
      await complete(simple.product_id);
      await service.state(simple.product_id, undefined, 'activate', {}, actor);
      const parentBody = createRequest(true),
        parent = await service.createProduct(parentBody, actor);
      const child = await service.createVariant(
        parent.product_id,
        {
          sku: '000-' + randomUUID(),
          atributosIdentificadores: [
            {
              caracteristica_id: 'size',
              nombre: 'Size',
              valor_id: 'S',
              valor: 'S',
            },
          ],
          imagenUrl: 'https://example.test/variant',
          perfilFisico: fullProfile,
        },
        actor,
      );
      await complete(parent.product_id);
      await service.state(
        parent.product_id,
        child.variant_id,
        'activate',
        undefined,
        actor,
      );
      await service.state(parent.product_id, undefined, 'activate', {}, actor);
      const queries = new CatalogQueryRepository(database, {
        timeoutMs: 60000,
      });
      const physical = await queries.physicalData([
        simpleBody.skuBase,
        parentBody.skuBase,
        child.sku,
        'missing',
      ]);
      expect(physical.noEncontrados).toEqual([parentBody.skuBase, 'missing']);
      expect(physical.productos).toEqual([
        expect.objectContaining({
          sku: simpleBody.skuBase,
          estado: 'ACTIVO',
          pesoKg: 1.5,
          dimensionesCm: { largo: 10, ancho: 20, alto: 30 },
        }),
        expect.objectContaining({ sku: child.sku, estado: 'ACTIVO' }),
      ]);
      expect(await queries.productPreparation(parent.product_id)).toMatchObject(
        {
          inventario: null,
          pricing: { status: 'COMPLETED', manual_retry_allowed: false },
          variantes: [
            {
              inventario: { status: 'COMPLETED', manual_retry_allowed: false },
            },
          ],
        },
      );
      expect(
        await queries.listVariants(parent.product_id, 1, 20, 'ACTIVA'),
      ).toMatchObject({
        items: [
          { variant_id: child.variant_id, sku: child.sku, status: 'ACTIVA' },
        ],
        meta: { pagina: 1, tamanio: 20, total: 1, totalPaginas: 1 },
      });
      expect(
        await queries.findVariant(parent.product_id, child.variant_id),
      ).toMatchObject({
        variant_id: child.variant_id,
        physical_profile: { sku: child.sku },
      });
      expect(
        await queries.findVariant(simple.product_id, child.variant_id),
      ).toBeNull();
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

      const schemaTables = [
        'products',
        'variants',
        'sku_identity',
        'product_images',
        'variant_images',
        'product_attribute_values',
        'variant_attribute_values',
        'product_identifying_characteristics',
        'sku_physical_profiles',
        'activation_checks',
        'master_barriers',
        'outbox',
        'inbox',
      ];
      const mutableTables = new Set([
        'products',
        'variants',
        'product_images',
        'variant_images',
        'product_attribute_values',
        'variant_attribute_values',
        'product_identifying_characteristics',
        'sku_physical_profiles',
        'activation_checks',
        'master_barriers',
      ]);
      const deletableTables = new Set([
        'product_images',
        'variant_images',
        'product_attribute_values',
        'variant_attribute_values',
        'product_identifying_characteristics',
        'sku_physical_profiles',
      ]);
      const grants = await database.read((db) =>
        db.execute(sql`
          SELECT table_name,
            has_table_privilege(current_user, format('catalog.%I', table_name), 'SELECT') AS can_select,
            has_table_privilege(current_user, format('catalog.%I', table_name), 'INSERT') AS can_insert,
            has_table_privilege(current_user, format('catalog.%I', table_name), 'UPDATE') AS can_update,
            has_table_privilege(current_user, format('catalog.%I', table_name), 'DELETE') AS can_delete
          FROM (VALUES
            ('products'), ('variants'), ('sku_identity'), ('product_images'),
            ('variant_images'), ('product_attribute_values'),
            ('variant_attribute_values'), ('product_identifying_characteristics'),
            ('sku_physical_profiles'), ('activation_checks'), ('master_barriers'),
            ('outbox'), ('inbox')
          ) AS tables(table_name)
        `),
      );
      expect(grants.rows).toHaveLength(schemaTables.length);
      expect(grants.rows).toEqual(
        expect.arrayContaining(
          schemaTables.map((table_name) => ({
            table_name,
            can_select: true,
            can_insert: true,
            can_update: mutableTables.has(table_name),
            can_delete: deletableTables.has(table_name),
          })),
        ),
      );

      const outboxColumnGrants = await database.read((db) =>
        db.execute(sql`
          SELECT column_name,
            has_column_privilege(current_user, 'catalog.outbox', column_name, 'UPDATE') AS can_update
          FROM unnest(ARRAY['published_at', 'attempts', 'last_error', 'payload']::text[])
            AS columns(column_name)
        `),
      );
      expect(outboxColumnGrants.rows).toEqual(
        expect.arrayContaining([
          { column_name: 'published_at', can_update: true },
          { column_name: 'attempts', can_update: true },
          { column_name: 'last_error', can_update: true },
          { column_name: 'payload', can_update: false },
        ]),
      );

      const sku = 'SKU-' + randomUUID();
      const product = await transactions.run((tx) =>
        repository.insertProduct(tx, productInput(sku)),
      );
      await database.read((db) =>
        db.execute(sql`
          UPDATE catalog.products SET descripcion = 'Runtime permission fixture updated'
          WHERE id = ${product.id}
        `),
      );
      const updatedProduct = await database.read((db) =>
        db.execute(
          sql`SELECT descripcion FROM catalog.products WHERE id = ${product.id}`,
        ),
      );
      expect(updatedProduct.rows[0]?.descripcion).toBe(
        'Runtime permission fixture updated',
      );
      await expect(
        database.read((db) =>
          db.execute(
            sql`DELETE FROM catalog.products WHERE id = ${product.id}`,
          ),
        ),
      ).rejects.toMatchObject({ failure: 'other', sqlState: '42501' });
      await expect(
        database.read((db) =>
          db.execute(
            sql`UPDATE catalog.sku_identity SET sku = ${'SKU-' + randomUUID()} WHERE sku = ${sku}`,
          ),
        ),
      ).rejects.toMatchObject({ failure: 'other', sqlState: '42501' });
      await expect(
        database.read((db) =>
          db.execute(sql`DELETE FROM catalog.sku_identity WHERE sku = ${sku}`),
        ),
      ).rejects.toMatchObject({ failure: 'other', sqlState: '42501' });

      const imageId = randomUUID();
      await database.read((db) =>
        db.execute(sql`
          INSERT INTO catalog.product_images (id, product_id, url)
          VALUES (${imageId}, ${product.id}, 'https://example.test/catalog-fixture')
        `),
      );
      await database.read((db) =>
        db.execute(sql`
          UPDATE catalog.product_images
          SET url = 'https://example.test/catalog-fixture-updated'
          WHERE id = ${imageId}
        `),
      );
      await database.read((db) =>
        db.execute(
          sql`DELETE FROM catalog.product_images WHERE id = ${imageId}`,
        ),
      );

      const outboxMessageId = randomUUID();
      await database.read((db) =>
        db.execute(sql`
          INSERT INTO catalog.outbox
            (message_id, event_name, kind, correlation_id, occurred_at, payload)
          VALUES (
            ${outboxMessageId}, 'catalog.test', 'event', ${randomUUID()},
            now(), ${JSON.stringify({ immutable: true })}::jsonb
          )
        `),
      );
      await database.read((db) =>
        db.execute(sql`
          UPDATE catalog.outbox SET attempts = attempts + 1, last_error = 'fixture retry'
          WHERE message_id = ${outboxMessageId}
        `),
      );
      await database.read((db) =>
        db.execute(sql`
          UPDATE catalog.outbox SET published_at = now()
          WHERE message_id = ${outboxMessageId}
        `),
      );
      const outboxRow = await database.read((db) =>
        db.execute(
          sql`SELECT payload FROM catalog.outbox WHERE message_id = ${outboxMessageId}`,
        ),
      );
      expect(outboxRow.rows[0]?.payload).toEqual({ immutable: true });
      await expect(
        database.read((db) =>
          db.execute(sql`
            UPDATE catalog.outbox SET payload = ${JSON.stringify({ changed: true })}::jsonb
            WHERE message_id = ${outboxMessageId}
          `),
        ),
      ).rejects.toMatchObject({ failure: 'other', sqlState: '42501' });

      await database.onModuleDestroy();
      closed = true;
      await expect(database.read(async () => true)).rejects.toMatchObject({
        failure: 'connection',
      });
    });
  },
);
