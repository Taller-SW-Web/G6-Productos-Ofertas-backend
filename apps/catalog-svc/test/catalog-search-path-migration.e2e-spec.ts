import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

const container = `catalog-search-path-${randomUUID().slice(0, 8)}`;
const docker = (args: string[], input?: string) => {
  const result = spawnSync('docker', args, {
    input,
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true,
  });
  if (result.status !== 0)
    throw new Error(
      `Disposable PostgreSQL command failed: ${result.error?.message ?? result.stderr?.slice(-1000) ?? 'unknown error'}`,
    );
  return result.stdout.trim();
};
const psql = (sql: string) =>
  docker(
    [
      'exec',
      '-i',
      '-e',
      'PGPASSWORD=disposable-only',
      container,
      'psql',
      '-h',
      '127.0.0.1',
      '-U',
      'postgres',
      '-v',
      'ON_ERROR_STOP=1',
      '-At',
    ],
    sql,
  );
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
    docker([
      'run',
      '--detach',
      '--name',
      container,
      '--publish',
      '127.0.0.1::5432',
      '--env',
      'POSTGRES_PASSWORD=disposable-only',
      'postgres:17-alpine',
    ]);
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      // The image briefly starts a socket-only server for initialization; only
      // the authenticated TCP probe proves the final server is ready.
      if (
        spawnSync(
          'docker',
          [
            'exec',
            '-e',
            'PGPASSWORD=disposable-only',
            container,
            'psql',
            '-h',
            '127.0.0.1',
            '-U',
            'postgres',
            '-At',
            '-c',
            'SELECT 1',
          ],
          { windowsHide: true, stdio: 'ignore' },
        ).status === 0
      ) {
        ready = true;
        break;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    }
    if (!ready)
      throw new Error('Disposable PostgreSQL 17 did not become ready.');
    const fixture = readFileSync(
      resolve('apps/catalog-svc/test/fixtures/0001_create_catalog.sql'),
      'utf8',
    );
    psql(
      `CREATE ROLE po_catalog_owner NOLOGIN; CREATE ROLE catalog_app LOGIN PASSWORD 'runtime-only'; CREATE SCHEMA catalog AUTHORIZATION po_catalog_owner; SET ROLE po_catalog_owner;\n${fixture}`,
    );
  }, 90_000);

  afterAll(() => {
    spawnSync('docker', ['rm', '--force', container], {
      timeout: 20_000,
      windowsHide: true,
      stdio: 'ignore',
    });
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
