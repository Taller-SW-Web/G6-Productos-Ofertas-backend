import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = dirname(fileURLToPath(import.meta.url));
const identifier = /^[a-z][a-z0-9_]*$/;
export const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

function fail(code) {
  throw new Error(code);
}
function assertion(body) {
  let suffix = 0;
  while (body.includes(`$assert_${suffix}$`)) suffix++;
  return `DO $assert_${suffix}$ ${body} $assert_${suffix}$;`;
}
function quote(name) {
  if (!identifier.test(name)) fail('INVALID_IDENTIFIER');
  return `"${name}"`;
}
function literal(value) {
  if (value === null) return 'NULL';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) fail('USE_STRING_FOR_DECIMAL_OR_BIGINT');
    return String(value);
  }
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text.includes('\0')) fail('INVALID_VALUE');
  // E strings explicitly escape backslashes regardless of server defaults.
  return `E'${text.replaceAll('\\', '\\\\').replaceAll("'", "''")}'`;
}

export function parseArgs(args) {
  const result = { mode: 'verify', render: false };
  for (let i = 0; i < args.length; i++) {
    const option = args[i];
    if (option === '--render-sql') {
      if (result.render) fail('DUPLICATE_OPTION');
      result.render = true;
    } else if (
      ['--schema', '--environment', '--kind', '--mode', '--psql'].includes(
        option,
      )
    ) {
      const key = option.slice(2);
      if (Object.hasOwn(result, key) && key !== 'mode')
        fail('DUPLICATE_OPTION');
      if (!args[i + 1] || args[i + 1].startsWith('--'))
        fail('MISSING_OPTION_VALUE');
      result[key] = args[++i];
    } else fail('UNKNOWN_OPTION');
  }
  if (!result.schema || !result.environment || !result.kind)
    fail('REQUIRED_OPTIONS');
  if (!['verify', 'apply'].includes(result.mode)) fail('INVALID_MODE');
  return result;
}

export function validateSelection(registry, options) {
  if (!['verify', 'apply'].includes(options.mode)) fail('INVALID_MODE');
  if (!Object.hasOwn(registry.schemas, options.schema))
    fail('UNAUTHORIZED_SCHEMA');
  if (!Object.hasOwn(registry.environments, options.environment))
    fail('UNAUTHORIZED_ENVIRONMENT');
  if (!['required', 'demo'].includes(options.kind)) fail('INVALID_KIND');
  const target = registry.environments[options.environment];
  if (target.production && options.kind === 'demo') fail('DEMO_IN_PRODUCTION');
  if (target.verify_only && options.mode === 'apply')
    fail('TARGET_VERIFY_ONLY');
}

export function validateConnection(registry, options, env) {
  validateSelection(registry, options);
  const target = registry.environments[options.environment];
  if (
    env.SEED_ENVIRONMENT !== options.environment ||
    env.SEED_PROJECT_REF !== registry.project_ref
  )
    fail('DESTINATION_MISMATCH');
  if (
    !target.hosts.includes(env.PGHOST) ||
    !target.ports.includes(Number(env.PGPORT)) ||
    env.PGDATABASE !== registry.database
  )
    fail('UNAUTHORIZED_DESTINATION');
  if (env.PGSSLMODE !== 'verify-full' || !env.PGSSLROOTCERT)
    fail('SSL_VERIFY_FULL_REQUIRED');
  if (
    !env.PGUSER ||
    env.PGUSER.startsWith('postgres') ||
    env.PGUSER.includes('runtime') ||
    env.PGUSER.endsWith('_app')
  )
    fail('DEDICATED_LOGIN_REQUIRED');
  if (!env.PGPASSWORD && !env.PGPASSFILE) fail('MISSING_CREDENTIAL');
}

export function loadSeeds(options, base = root) {
  const directory = realpathSync(join(base, options.kind, options.schema));
  if (!directory.startsWith(realpathSync(base) + sep)) fail('SEED_PATH_ESCAPE');
  const seeds = [];
  for (const filename of readdirSync(directory).sort()) {
    if (!filename.endsWith('.json')) continue;
    if (!/^\d{3}_[a-z0-9_]+\.json$/.test(filename))
      fail('INVALID_SEED_FILENAME');
    const path = realpathSync(join(directory, filename));
    if (!path.startsWith(directory + sep)) fail('SEED_PATH_ESCAPE');
    const content = readFileSync(path, 'utf8');
    seeds.push({
      filename,
      data: JSON.parse(content),
      checksum: createHash('sha256')
        .update(content.replaceAll('\r\n', '\n'))
        .digest('hex'),
    });
  }
  if (!seeds.length) fail('NO_APPROVED_SEEDS');
  return seeds;
}

export function renderTransaction(registry, options, seeds) {
  validateSelection(registry, options);
  const schema = options.schema;
  const role = `po_${schema}_seed`;
  const body = [];
  for (const seed of seeds) {
    const data = seed.data;
    if (
      data.version !== 1 ||
      data.schema !== schema ||
      data.kind !== options.kind ||
      !Array.isArray(data.inserts) ||
      !data.inserts.length
    )
      fail('INVALID_SEED');
    for (const insert of data.inserts) {
      const rules = registry.schemas[schema].tables;
      if (!Object.hasOwn(rules, insert.table)) fail('UNAUTHORIZED_TABLE');
      const rule = rules[insert.table];
      if (!Array.isArray(insert.rows) || !insert.rows.length)
        fail('EMPTY_INSERT');
      for (const row of insert.rows) {
        const columns = Object.keys(row);
        if (
          !columns.length ||
          columns.some((c) => !rule.columns.includes(c)) ||
          rule.key.some((c) => !Object.hasOwn(row, c) || row[c] === null)
        )
          fail('UNAUTHORIZED_COLUMNS_OR_MISSING_KEY');
        const table = `${quote(schema)}.${quote(insert.table)}`;
        const predicate = columns
          .map((c) => `${quote(c)} IS NOT DISTINCT FROM ${literal(row[c])}`)
          .join(' AND ');
        body.push(
          `INSERT INTO ${table} (${columns.map(quote).join(', ')}) VALUES (${columns.map((c) => literal(row[c])).join(', ')}) ON CONFLICT (${rule.key.map(quote).join(', ')}) DO NOTHING;`,
        );
        // A reused key with changed content must fail instead of being silently skipped.
        body.push(
          assertion(
            `BEGIN IF NOT EXISTS (SELECT 1 FROM ${table} WHERE ${predicate}) THEN RAISE EXCEPTION 'SEED_CONTENT_CONFLICT'; END IF; END`,
          ),
        );
      }
    }
  }
  const statements = body.join('\n');
  if (!statements) fail('EMPTY_SEED');
  return `BEGIN;
SET LOCAL statement_timeout = '30s';
SET LOCAL lock_timeout = '5s';
SET LOCAL standard_conforming_strings = on;
SET LOCAL search_path = pg_catalog;
DO $access$ BEGIN
  IF NOT pg_has_role(current_user, '${role}', 'SET') THEN RAISE EXCEPTION 'SEED_ROLE_REQUIRED'; END IF;
END $access$;
SET LOCAL ROLE ${quote(role)};
DO $isolation$ DECLARE s text; BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls))
     OR has_schema_privilege(current_user, '${schema}', 'CREATE') THEN RAISE EXCEPTION 'EXCESSIVE_SEED_PRIVILEGES'; END IF;
  FOREACH s IN ARRAY ARRAY[${Object.keys(registry.schemas).map(literal).join(',')}] LOOP
    IF s <> '${schema}' AND (has_schema_privilege(current_user,s,'USAGE') OR has_schema_privilege(current_user,s,'CREATE')) THEN RAISE EXCEPTION 'CROSS_SCHEMA_PRIVILEGES'; END IF;
  END LOOP;
END $isolation$;
SELECT pg_advisory_xact_lock(hashtextextended('g6-seed:${schema}', 0));
${statements}
${options.mode === 'verify' ? statements : ''}
SET CONSTRAINTS ALL IMMEDIATE;
SELECT 'SEED_VALIDATED' AS result, current_user AS seed_role;
${options.mode === 'verify' ? 'ROLLBACK' : 'COMMIT'};
`;
}

export function execute(sql, options, env, spawn = spawnSync) {
  const role = `po_${options.schema}_seed`;
  const loginCheck = `DO $login$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=session_user AND (rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls))
       OR EXISTS (SELECT 1 FROM pg_namespace WHERE nspowner=(SELECT oid FROM pg_roles WHERE rolname=session_user))
       OR EXISTS (SELECT 1 FROM pg_roles WHERE rolname <> session_user AND rolname <> '${role}' AND pg_has_role(session_user,oid,'MEMBER')) THEN
      RAISE EXCEPTION 'DEDICATED_UNPRIVILEGED_LOGIN_REQUIRED';
    END IF;
  END $login$;`;
  const guardedSql = sql.replace('BEGIN;', `BEGIN;\n${loginCheck}`);
  // Pass only libpq's explicit allowlist; PGOPTIONS/PGSERVICE and URL credentials cannot override the destination.
  const allowed = [
    'PATH',
    'Path',
    'SystemRoot',
    'SYSTEMROOT',
    'WINDIR',
    'TEMP',
    'TMP',
    'HOME',
    'APPDATA',
    'PGHOST',
    'PGPORT',
    'PGDATABASE',
    'PGUSER',
    'PGPASSWORD',
    'PGPASSFILE',
    'PGSSLMODE',
    'PGSSLROOTCERT',
  ];
  const childEnv = Object.fromEntries(
    allowed
      .filter((key) => env[key] !== undefined)
      .map((key) => [key, env[key]]),
  );
  childEnv.PGCONNECT_TIMEOUT = '10';
  childEnv.PGAPPNAME = 'g6-seed-infra-001';
  childEnv.PGCLIENTENCODING = 'UTF8';
  const result = spawn(
    options.psql ?? 'psql',
    [
      '-X',
      '-w',
      '-q',
      '-v',
      'ON_ERROR_STOP=1',
      '-v',
      'VERBOSITY=sqlstate',
      '-f',
      '-',
    ],
    {
      input: guardedSql,
      encoding: 'utf8',
      env: childEnv,
      timeout: 60000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    },
  );
  // Never forward raw libpq/server errors: SQL context may contain credentials or fixture values.
  if (result.error || result.status !== 0)
    fail('PSQL_FAILED_CHECK_CLIENT_CONNECTION_AND_SQL');
  if (!result.stdout.includes('SEED_VALIDATED'))
    fail('MISSING_DATABASE_ASSERTION');
  return {
    status: 'PASS',
    schema: options.schema,
    environment: options.environment,
    mode: options.mode,
    persistent_data: options.mode === 'apply',
  };
}

export function main(args, env = process.env) {
  const options = parseArgs(args);
  const registry = readJson(join(root, 'registry.json'));
  validateSelection(registry, options);
  const seeds = loadSeeds(options);
  const sql = renderTransaction(registry, options, seeds);
  if (options.render) {
    process.stdout.write(sql);
    return;
  }
  validateConnection(registry, options, env);
  console.log(
    JSON.stringify({
      ...execute(sql, options, env),
      seeds: seeds.map(({ filename, checksum }) => ({ filename, checksum })),
    }),
  );
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    const code =
      error instanceof SyntaxError
        ? 'INVALID_JSON'
        : error.code === 'ENOENT'
          ? 'MISSING_SEEDS_OR_CONFIGURATION'
          : error.message;
    console.error(/^[A-Z_]+$/.test(code) ? code : 'SEED_FAILED');
    process.exitCode = 1;
  }
}
