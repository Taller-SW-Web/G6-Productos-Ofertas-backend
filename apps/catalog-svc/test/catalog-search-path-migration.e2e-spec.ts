import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

const container = `catalog-search-path-${randomUUID().slice(0, 8)}`;
const postgresPassword = 'disposable-only';
const docker = (args: string[], input?: string, timeout = 60_000) => {
  const result = spawnSync('docker', args, {
    input,
    encoding: 'utf8',
    timeout,
    windowsHide: true,
  });
  if (result.status !== 0) {
    const details = result.error?.message ?? result.stderr ?? 'unknown error';
    throw new Error(
      `Disposable PostgreSQL command failed: ${details
        .replaceAll(postgresPassword, '[redacted]')
        .replace(/PGPASSWORD=\S+/g, 'PGPASSWORD=[redacted]')
        .slice(-1000)}`,
    );
  }
  return result.stdout.trim();
};
const psql = (sql: string, timeout = 60_000) =>
  docker(
    [
      'exec',
      '-i',
      '--env',
      `PGPASSWORD=${postgresPassword}`,
      container,
      'psql',
      '-h',
      '127.0.0.1',
      '-p',
      '5432',
      '-U',
      'postgres',
      '-v',
      'ON_ERROR_STOP=1',
      '-At',
    ],
    sql,
    timeout,
  );
const removeContainer = () => {
  const listContainers = () =>
    spawnSync(
      'docker',
      [
        'container',
        'ls',
        '--all',
        '--filter',
        `name=^/${container}$`,
        '--format',
        '{{.Names}}',
      ],
      { encoding: 'utf8', timeout: 5_000, windowsHide: true },
    );
  const inspection = listContainers();
  if (inspection.status !== 0)
    throw new Error(
      'Could not verify the disposable PostgreSQL container state.',
    );
  if (!inspection.stdout.trim()) return;
  docker(['rm', '--force', container], undefined, 10_000);
  const afterRemoval = listContainers();
  if (afterRemoval.status !== 0)
    throw new Error('Could not verify PostgreSQL container cleanup.');
  if (afterRemoval.stdout.trim())
    throw new Error('Disposable PostgreSQL container remained after cleanup.');
};
const sanitizedContainerLogs = () => {
  const result = spawnSync('docker', ['logs', container], {
    encoding: 'utf8',
    timeout: 5_000,
    windowsHide: true,
  });
  return `${result.stdout ?? ''}${result.stderr ?? ''}`
    .replaceAll(postgresPassword, '[redacted]')
    .replace(/PGPASSWORD=\S+/g, 'PGPASSWORD=[redacted]')
    .slice(-4_000);
};
const targets = `ARRAY[
  'catalog.fn_assert_product(uuid)'::regprocedure,
  'catalog.fn_check_aggregate()'::regprocedure,
  'catalog.fn_guard_dependency()'::regprocedure,
  'catalog.fn_guard_identity()'::regprocedure,
  'catalog.fn_lock_aggregate()'::regprocedure,
  'catalog.fn_register_sku()'::regprocedure,
  'catalog.fn_row_product(jsonb,text)'::regprocedure,
  'catalog.fn_set_updated_at()'::regprocedure
]`;
const snapshot = () =>
  JSON.parse(
    psql(`SELECT jsonb_agg(jsonb_build_object(
  'signature', p.oid::regprocedure::text,
  'owner', p.proowner,
  'acl', p.proacl,
  'source', p.prosrc,
  'triggers', (SELECT count(*) FROM pg_trigger t WHERE t.tgfoid=p.oid AND NOT t.tgisinternal),
  'runtime_execute', has_function_privilege('catalog_app', p.oid, 'EXECUTE'),
  'config', p.proconfig
) ORDER BY p.oid)::text FROM pg_proc p WHERE p.oid = ANY(${targets});`),
  );

describe('CAT-D04: PostgreSQL 17 disposable search_path migration', () => {
  beforeAll(() => {
    try {
      docker(
        [
          'run',
          '--detach',
          '--name',
          container,
          '--env',
          `POSTGRES_PASSWORD=${postgresPassword}`,
          'postgres:17-alpine',
        ],
        undefined,
        15_000,
      );
      const deadline = Date.now() + 60_000;
      let ready = false;
      while (Date.now() < deadline) {
        const remaining = deadline - Date.now();
        const probeTimeout = Math.min(3_000, remaining);
        const pgReady = spawnSync(
          'docker',
          [
            'exec',
            container,
            'pg_isready',
            '-h',
            '127.0.0.1',
            '-p',
            '5432',
            '-U',
            'postgres',
            '-t',
            '2',
          ],
          { windowsHide: true, stdio: 'ignore', timeout: probeTimeout },
        );
        const selectOne = spawnSync(
          'docker',
          [
            'exec',
            '--env',
            `PGPASSWORD=${postgresPassword}`,
            container,
            'psql',
            '-h',
            '127.0.0.1',
            '-p',
            '5432',
            '-U',
            'postgres',
            '-v',
            'ON_ERROR_STOP=1',
            '-At',
            '-c',
            'SELECT 1',
          ],
          { encoding: 'utf8', windowsHide: true, timeout: probeTimeout },
        );
        if (
          pgReady.status === 0 &&
          selectOne.status === 0 &&
          selectOne.stdout.trim() === '1'
        ) {
          ready = true;
          break;
        }
        const waitMs = Math.min(250, Math.max(0, deadline - Date.now()));
        if (waitMs > 0)
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs);
      }
      if (!ready)
        throw new Error(
          'PostgreSQL 17 TCP readiness/SELECT 1 deadline exceeded.',
        );
      const fixture = readFileSync(
        resolve('apps/catalog-svc/test/fixtures/0001_create_catalog.sql'),
        'utf8',
      );
      psql(
        `CREATE ROLE po_catalog_owner NOLOGIN; CREATE ROLE catalog_app LOGIN PASSWORD 'runtime-only'; CREATE SCHEMA catalog AUTHORIZATION po_catalog_owner; SET ROLE po_catalog_owner;\n${fixture}`,
        Math.max(1, deadline - Date.now()),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const logs = sanitizedContainerLogs();
      let cleanup = 'completed';
      try {
        removeContainer();
      } catch {
        cleanup = 'failed';
      }
      throw new Error(
        `Disposable PostgreSQL initialization failed (${cleanup}): ${message}\nSanitized container logs:\n${logs || '[no container logs available]'}`,
      );
    }
  }, 90_000);

  afterAll(() => {
    removeContainer();
  }, 30_000);

  it('upgrade pins only eight functions, keeps ownership/ACL/body/triggers/runtime access and rollback restores prior config exactly', () => {
    const before = snapshot() as Array<Record<string, unknown>>;
    expect(before).toHaveLength(8);
    expect(before.every((fn) => fn.config === null)).toBe(true);
    const up = readFileSync(
      resolve(
        'apps/catalog-svc/migrations/0005_catalog_function_search_path.sql',
      ),
      'utf8',
    );
    psql(`BEGIN; SET LOCAL ROLE po_catalog_owner;\n${up}\nCOMMIT;`);
    const upgraded = snapshot() as Array<Record<string, unknown>>;
    expect(upgraded.map(({ config: _config, ...rest }) => rest)).toEqual(
      before.map(({ config: _config, ...rest }) => rest),
    );
    expect(
      upgraded.every(
        (fn) =>
          Array.isArray(fn.config) &&
          (fn.config as string[]).includes('search_path=pg_catalog, catalog'),
      ),
    ).toBe(true);

    const positive = psql(`SET ROLE po_catalog_owner;
      INSERT INTO catalog.products (id,nombre,descripcion,categoria_id,tipo_producto_id,marca_id,sku_base,slug,tiene_variantes)
      VALUES ('00000000-0000-4000-8000-000000000050','Search path','fixture','cat','type','brand','search-path-50','search-path-50',false);
      UPDATE catalog.products SET descripcion='updated' WHERE id='00000000-0000-4000-8000-000000000050';
      SELECT descripcion FROM catalog.products WHERE id='00000000-0000-4000-8000-000000000050';`);
    expect(positive).toContain('updated');
    psql(`SET ROLE po_catalog_owner; DO $negative$ BEGIN
      BEGIN
        UPDATE catalog.products SET sku_base='changed' WHERE id='00000000-0000-4000-8000-000000000050';
        RAISE EXCEPTION 'expected immutable SKU guard';
      EXCEPTION WHEN check_violation THEN NULL; END;
    END $negative$;`);

    const down = readFileSync(
      resolve(
        'apps/catalog-svc/migrations/rollback/0005_catalog_function_search_path.sql',
      ),
      'utf8',
    );
    psql(`BEGIN; SET LOCAL ROLE po_catalog_owner;\n${down}\nCOMMIT;`);
    const rolledBack = snapshot() as Array<Record<string, unknown>>;
    expect(rolledBack).toEqual(before);
  }, 90_000);
});
