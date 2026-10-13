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
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const option = args[i];
    if (seen.has(option)) fail('DUPLICATE_OPTION');
    seen.add(option);
    if (option === '--render-sql') {
      result.render = true;
    } else if (option === '--check-access') {
      result.checkAccess = true;
    } else if (
      ['--schema', '--environment', '--kind', '--mode', '--psql'].includes(
        option,
      )
    ) {
      const key = option.slice(2);
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
  if (options.checkAccess && options.mode !== 'verify')
    fail('ACCESS_CHECK_REQUIRES_VERIFY');
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
    env.PGHOST.endsWith('.pooler.supabase.com') &&
    !env.PGUSER?.endsWith(`.${registry.project_ref}`)
  )
    fail('POOLER_PROJECT_USER_REQUIRED');
  if (
    !env.PGUSER ||
    env.PGUSER.startsWith('postgres') ||
    env.PGUSER.includes('runtime') ||
    env.PGUSER.endsWith('_app')
  )
    fail('DEDICATED_LOGIN_REQUIRED');
  if (!env.PGPASSWORD && !env.PGPASSFILE) fail('MISSING_CREDENTIAL');
  resolveAccount(registry, options, env.PGUSER);
}

export function resolveAccount(registry, options, username) {
  const suffix = `.${registry.project_ref}`;
  const login = username?.endsWith(suffix)
    ? username.slice(0, -suffix.length)
    : username;
  if (!Object.hasOwn(registry.accounts, login)) fail('UNAUTHORIZED_LOGIN');
  const account = registry.accounts[login];
  if (!account.schemas.includes(options.schema))
    fail('UNAUTHORIZED_ACCOUNT_SCHEMA');
  return { login, roles: account.schemas.map((schema) => `po_${schema}_seed`) };
}

export function renderLoginCheck(registry, options, username) {
  const account = resolveAccount(registry, options, username);
  return `DO $login$ BEGIN
    IF session_user <> ${literal(account.login)}
       OR EXISTS (SELECT 1 FROM pg_roles WHERE rolname=session_user AND (rolinherit OR rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls))
       OR EXISTS (SELECT 1 FROM pg_namespace WHERE nspowner=(SELECT oid FROM pg_roles WHERE rolname=session_user))
       OR EXISTS (SELECT 1 FROM pg_database WHERE datdba=(SELECT oid FROM pg_roles WHERE rolname=session_user))
       OR EXISTS (SELECT 1 FROM pg_roles WHERE rolname <> session_user AND rolname <> ALL(ARRAY[${account.roles.map(literal).join(',')}]) AND pg_has_role(session_user,oid,'MEMBER'))
       OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=session_user) AND (admin_option OR inherit_option OR NOT set_option))
       OR EXISTS (SELECT 1 FROM pg_namespace WHERE nspname IN (${Object.keys(registry.schemas).map(literal).join(',')}) AND (has_schema_privilege(session_user,oid,'USAGE') OR has_schema_privilege(session_user,oid,'CREATE'))) THEN
      RAISE EXCEPTION 'DEDICATED_UNPRIVILEGED_LOGIN_REQUIRED';
    END IF;
  END $login$;`;
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

function transactionPrelude(registry, options) {
  validateSelection(registry, options);
  const schema = options.schema;
  const role = `po_${schema}_seed`;
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
END $isolation$;`;
}

export function renderAccessCheck(registry, options) {
  validateSelection(registry, options);
  if (options.mode !== 'verify') fail('ACCESS_CHECK_REQUIRES_VERIFY');
  const schema = options.schema;
  return `${transactionPrelude(registry, options)}
DO $permissions$ BEGIN
  IF NOT has_schema_privilege(current_user, '${schema}', 'USAGE') THEN RAISE EXCEPTION 'SEED_USAGE_REQUIRED'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='${schema}' AND c.relkind='r' AND has_any_column_privilege(current_user,c.oid,'INSERT')) THEN
    RAISE EXCEPTION 'NO_LOAD_PRIVILEGES';
  END IF;
END $permissions$;
SELECT 'SEED_VALIDATED' AS result, current_database() AS database,
       session_user AS login, current_user AS seed_role,
       EXISTS (SELECT 1 FROM pg_stat_ssl WHERE pid=pg_backend_pid() AND ssl) AS backend_ssl;
ROLLBACK;
`;
}

export function renderTransaction(registry, options, seeds) {
  validateSelection(registry, options);
  const schema = options.schema;
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
  return `${transactionPrelude(registry, options)}
SELECT pg_advisory_xact_lock(hashtextextended('g6-seed:${schema}', 0));
${statements}
${options.mode === 'verify' ? statements : ''}
SET CONSTRAINTS ALL IMMEDIATE;
SELECT 'SEED_VALIDATED' AS result, current_user AS seed_role;
${options.mode === 'verify' ? 'ROLLBACK' : 'COMMIT'};
`;
}

export function connectionEnvironment(env) {
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
  childEnv.LC_ALL = 'C';
  return childEnv;
}

export function execute(
  sql,
  options,
  env,
  spawn = spawnSync,
  registry = readJson(join(root, 'registry.json')),
) {
  const loginCheck = renderLoginCheck(registry, options, env.PGUSER);
  const guardedSql = `\\conninfo\n${sql.replace('BEGIN;', `BEGIN;\n${loginCheck}`)}`;
  const childEnv = connectionEnvironment(env);
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
  if (!/^SSL connection \(/m.test(result.stdout))
    fail('MISSING_CLIENT_SSL_ASSERTION');
  return {
    status: 'PASS',
    schema: options.schema,
    environment: options.environment,
    mode: options.mode,
    check_access_only: options.checkAccess ?? false,
    persistent_data: options.mode === 'apply',
  };
}

export function main(args, env = process.env) {
  const options = parseArgs(args);
  const registry = readJson(join(root, 'registry.json'));
  validateSelection(registry, options);
  const seeds = options.checkAccess ? [] : loadSeeds(options);
  const sql = options.checkAccess
    ? renderAccessCheck(registry, options)
    : renderTransaction(registry, options, seeds);
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
