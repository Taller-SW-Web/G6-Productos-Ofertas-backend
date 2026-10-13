import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  execute,
  loadSeeds,
  parseArgs,
  readJson,
  renderTransaction,
  validateConnection,
  validateSelection,
} from './run.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const registry = readJson(join(root, 'registry.json'));
const options = {
  schema: 'promotions',
  environment: 'shared',
  kind: 'demo',
  mode: 'verify',
};
const seeds = loadSeeds(options);
const env = {
  SEED_ENVIRONMENT: 'shared',
  SEED_PROJECT_REF: registry.project_ref,
  PGHOST: registry.environments.shared.hosts[0],
  PGPORT: '5432',
  PGDATABASE: 'postgres',
  PGUSER: 'seed_promotions',
  PGPASSWORD: 'test-only-secret',
  PGSSLMODE: 'verify-full',
  PGSSLROOTCERT: '/local/ca.crt',
};

test('only explicit schema/environment/kind/mode options are accepted', () => {
  assert.deepEqual(
    parseArgs([
      '--schema',
      'promotions',
      '--environment',
      'shared',
      '--kind',
      'demo',
    ]),
    { ...options, render: false },
  );
  for (const args of [
    [],
    ['--url', 'x'],
    ['--schema'],
    ['--schema', 'promotions', '--schema', 'bulk'],
  ])
    assert.throws(() => parseArgs(args));
  assert.throws(
    () => validateSelection(registry, { ...options, schema: '../catalog' }),
    /UNAUTHORIZED_SCHEMA/,
  );
  assert.throws(
    () => validateSelection(registry, { ...options, environment: 'other' }),
    /UNAUTHORIZED_ENVIRONMENT/,
  );
  assert.throws(
    () => validateSelection(registry, { ...options, mode: 'apply' }),
    /TARGET_VERIFY_ONLY/,
  );
});

test('demo is rejected in production before reading seeds or connecting', () => {
  const production = structuredClone(registry);
  production.environments.shared.production = true;
  assert.throws(
    () => validateSelection(production, options),
    /DEMO_IN_PRODUCTION/,
  );
});

test('rejects wrong project, destination, database, insecure SSL and admin/runtime credentials', () => {
  validateConnection(registry, options, env);
  for (const [key, value] of Object.entries({
    SEED_PROJECT_REF: 'another',
    SEED_ENVIRONMENT: 'production',
    PGHOST: 'evil.example',
    PGPORT: '6543',
    PGDATABASE: 'another',
    PGSSLMODE: 'require',
    PGSSLROOTCERT: '',
    PGUSER: 'postgres.project',
    PGPASSWORD: '',
  })) {
    assert.throws(() =>
      validateConnection(registry, options, { ...env, [key]: value }),
    );
  }
  assert.throws(() =>
    validateConnection(registry, options, {
      ...env,
      PGUSER: 'po_promotions_runtime',
    }),
  );
});

test('verification repeats all inserts in one restricted transaction and rolls back', () => {
  const sql = renderTransaction(registry, options, seeds);
  assert.equal((sql.match(/INSERT INTO/g) ?? []).length, 2);
  assert.equal((sql.match(/BEGIN;/g) ?? []).length, 1);
  assert.match(sql, /SET LOCAL ROLE "po_promotions_seed"/);
  assert.match(sql, /ON CONFLICT \("sku"\) DO NOTHING/);
  assert.match(sql, /SEED_CONTENT_CONFLICT/);
  assert.match(sql, /CROSS_SCHEMA_PRIVILEGES/);
  assert.match(sql, /SET CONSTRAINTS ALL IMMEDIATE/);
  assert.match(sql, /ROLLBACK;\n$/);
  assert.doesNotMatch(sql, /COMMIT;/);
});

test('required apply commits only on an explicitly permitted destination', () => {
  const approved = structuredClone(registry);
  approved.environments.shared.verify_only = false;
  const required = structuredClone(seeds);
  required[0].data.kind = 'required';
  assert.match(
    renderTransaction(
      approved,
      { ...options, kind: 'required', mode: 'apply' },
      required,
    ),
    /COMMIT;\n$/,
  );
});

test('rejects cross-schema/table/column writes, missing identity and empty seeds', () => {
  const cases = [
    (data) => {
      data.schema = 'catalog';
    },
    (data) => {
      data.inserts[0].table = 'schema_migrations';
    },
    (data) => {
      data.inserts[0].rows[0].created_at = 'x';
    },
    (data) => {
      delete data.inserts[0].rows[0].sku;
    },
    (data) => {
      data.inserts = [];
    },
    (data) => {
      data.inserts[0].rows = [];
    },
  ];
  for (const mutate of cases) {
    const changed = structuredClone(seeds);
    mutate(changed[0].data);
    assert.throws(() => renderTransaction(registry, options, changed));
  }
  assert.throws(() => renderTransaction(registry, options, []), /EMPTY_SEED/);
  assert.throws(
    () => loadSeeds({ ...options, schema: 'taxonomy' }),
    /NO_APPROVED_SEEDS/,
  );
});

test('values with SQL, psql meta commands and dollar delimiters stay literal', () => {
  const changed = structuredClone(seeds);
  changed[0].data.inserts[0].rows[0].source_message_id =
    "'$assert_0$; COMMIT; \\! echo secret";
  const sql = renderTransaction(registry, options, changed);
  assert.match(sql, /DO \$assert_1\$/);
  assert.match(sql, /E'''\$assert_0\$; COMMIT; \\\\! echo secret'/);
});

test('psql gets secrets only through env, has no override vars, hides raw failures', () => {
  const sql = renderTransaction(registry, options, seeds);
  const spawn = (command, args, config) => {
    assert.equal(command, 'psql');
    assert.ok(args.includes('ON_ERROR_STOP=1'));
    assert.ok(args.includes('-X'));
    assert.ok(args.includes('-w'));
    assert.equal(config.env.PGPASSWORD, env.PGPASSWORD);
    assert.equal(config.env.PGOPTIONS, undefined);
    assert.equal(config.env.PGSERVICE, undefined);
    assert.ok(!args.join(' ').includes(env.PGPASSWORD));
    assert.match(config.input, /DEDICATED_UNPRIVILEGED_LOGIN_REQUIRED/);
    assert.ok(config.input.endsWith(sql.slice(sql.indexOf('\n') + 1)));
    assert.equal(config.windowsHide, true);
    return { status: 0, stdout: 'SEED_VALIDATED', stderr: '' };
  };
  assert.equal(
    execute(
      sql,
      options,
      { ...env, PGOPTIONS: '-c role=postgres', PGSERVICE: 'override' },
      spawn,
    ).persistent_data,
    false,
  );
  assert.throws(
    () =>
      execute(sql, options, env, () => ({ status: 1, stderr: env.PGPASSWORD })),
    { message: 'PSQL_FAILED_CHECK_CLIENT_CONNECTION_AND_SQL' },
  );
  assert.throws(
    () => execute(sql, options, env, () => ({ status: 0, stdout: '' })),
    /MISSING_DATABASE_ASSERTION/,
  );
});
