// Run locally with --env-file=.env.local. Never send this output to GitHub.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  connectionEnvironment,
  execute,
  loadSeeds,
  readJson,
  renderAccessCheck,
  renderTransaction,
  validateConnection,
} from '../run.mjs';

const seedRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function checkResult(result, marker) {
  if (
    result.error ||
    result.status !== 0 ||
    (marker && !result.stdout.includes(marker))
  ) {
    const error = result.stderr ?? '';
    if (/translate host|resolve|Name or service|Host desconocido/i.test(error))
      throw new Error('PSQL_DNS_FAILED');
    if (/password authentication failed|no password supplied|SASL/i.test(error))
      throw new Error('PSQL_AUTHENTICATION_FAILED');
    if (/certificate|SSL|root cert/i.test(error))
      throw new Error('PSQL_SSL_FAILED');
    if (/permission denied|role .*does not exist/i.test(error))
      throw new Error('PSQL_ROLE_PRIVILEGES_FAILED');
    if (
      result.error?.code === 'ETIMEDOUT' ||
      /unreachable|timed out|timeout|could not connect|refused/i.test(error)
    )
      throw new Error('PSQL_NETWORK_FAILED');
    throw new Error('PSQL_ACCESS_SETUP_FAILED');
  }
}

export function validateAdmin(registry, env) {
  const target = registry.environments[env.SEED_ENVIRONMENT];
  if (
    !target ||
    env.SEED_PROJECT_REF !== registry.project_ref ||
    !target.hosts.includes(env.PGHOST) ||
    !target.ports.includes(Number(env.PGPORT)) ||
    env.PGDATABASE !== registry.database ||
    !['postgres', `postgres.${registry.project_ref}`].includes(env.PGUSER)
  ) {
    throw new Error('UNAUTHORIZED_ADMIN_CONNECTION');
  }
  if (
    env.PGSSLMODE !== 'verify-full' ||
    !env.PGSSLROOTCERT ||
    !existsSync(env.PGSSLROOTCERT)
  ) {
    throw new Error('ADMIN_CA_REQUIRED');
  }
  if (
    (!env.PGPASSWORD && !env.PGPASSFILE) ||
    env.PGPASSWORD === 'REPLACE_LOCALLY'
  ) {
    throw new Error('ADMIN_CREDENTIAL_REQUIRED');
  }
}

export function setInitialPassword(
  psql,
  login,
  password,
  env,
  spawn = spawnSync,
) {
  if (!/^seed_[a-z]+$/.test(login)) throw new Error('INVALID_MEMBER_LOGIN');
  // psql \password encrypts client-side: no cleartext SQL, argv, history or server log.
  // PostgreSQL's documented Windows prompt fallback reads stdin with OSTYPE=msys.
  const childEnv = connectionEnvironment(env);
  if (process.platform === 'win32') childEnv.OSTYPE = 'msys';
  const result = spawn(
    psql,
    [
      '-X',
      '-w',
      '-q',
      '-v',
      'ON_ERROR_STOP=1',
      '-v',
      'VERBOSITY=sqlstate',
      '-c',
      `\\password ${login}`,
    ],
    {
      input: `${password}\n${password}\n`,
      encoding: 'utf8',
      env: childEnv,
      windowsHide: true,
      timeout: 30000,
      maxBuffer: 1024 * 1024,
    },
  );
  checkResult(result);
}

function privateDirectory() {
  const directory = mkdtempSync(join(tmpdir(), 'g6-seed-credentials-'), {
    mode: 0o700,
  });
  if (process.platform === 'win32') {
    const identity = spawnSync('whoami.exe', [], {
      encoding: 'utf8',
      windowsHide: true,
    });
    checkResult(identity);
    const result = spawnSync(
      'icacls.exe',
      [
        directory,
        '/inheritance:r',
        '/grant:r',
        `${identity.stdout.trim()}:(OI)(CI)F`,
      ],
      { encoding: 'utf8', windowsHide: true },
    );
    checkResult(result);
  }
  return directory;
}

export function setupCredentials(psql, env = process.env) {
  const registry = readJson(join(seedRoot, 'registry.json'));
  validateAdmin(registry, env);
  const adminCheck = spawnSync(
    psql,
    [
      '-X',
      '-w',
      '-q',
      '-t',
      '-A',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      '\\conninfo',
      '-c',
      "SELECT CASE WHEN current_user='postgres' AND current_database()='postgres' THEN 'ADMIN_CONNECTION_VERIFIED' ELSE 'ADMIN_CONNECTION_REJECTED' END;",
    ],
    {
      encoding: 'utf8',
      env: connectionEnvironment(env),
      windowsHide: true,
      timeout: 30000,
    },
  );
  checkResult(adminCheck, 'ADMIN_CONNECTION_VERIFIED');
  if (!/^SSL connection \(/m.test(adminCheck.stdout))
    throw new Error('ADMIN_CLIENT_SSL_REQUIRED');
  const directory = privateDirectory();
  const records = [];
  const passwords = new Set();
  const summary = [];
  const save = () =>
    writeFileSync(
      join(directory, 'credentials.json'),
      JSON.stringify(records, null, 2),
      { mode: 0o600 },
    );
  for (const [login, account] of Object.entries(registry.accounts)) {
    let password;
    do {
      password = randomBytes(32).toString('base64url');
    } while (passwords.has(password));
    passwords.add(password);
    const username = env.PGUSER.endsWith(`.${registry.project_ref}`)
      ? `${login}.${registry.project_ref}`
      : login;
    const record = {
      owner: account.owner,
      login,
      connection_user: username,
      schemas: account.schemas,
      host: env.PGHOST,
      port: env.PGPORT,
      database: env.PGDATABASE,
      sslmode: 'verify-full',
      password,
      password_status: 'GENERATED_NOT_ASSIGNED',
      checks: [],
      delivery_status: 'PENDING_PRIVATE_WHATSAPP_BY_AXEL',
      instruction:
        'Cambiar la contraseña al recibirla usando \\password en psql. Nunca enviarla al grupo.',
    };
    records.push(record);
    save(); // Recovery copy: a process failure must not lose an assigned initial password.
    try {
      setInitialPassword(psql, login, password, env);
      record.password_status = 'ASSIGNED';
      save();
      const memberEnv = { ...env, PGUSER: username, PGPASSWORD: password };
      delete memberEnv.PGPASSFILE;
      for (const schema of account.schemas) {
        const options = {
          schema,
          environment: env.SEED_ENVIRONMENT,
          kind: 'required',
          mode: 'verify',
          checkAccess: true,
          psql,
        };
        validateConnection(registry, options, memberEnv);
        execute(renderAccessCheck(registry, options), options, memberEnv);
        record.checks.push({
          schema,
          connection: 'PASS',
          ssl: 'verify-full',
          permissions: 'PASS',
          transaction: 'ROLLBACK',
          seed: 'NOT_EXECUTED_NO_APPROVED_SEED',
        });
        if (schema === 'promotions') {
          const demoOptions = { ...options, kind: 'demo', checkAccess: false };
          const seeds = loadSeeds(demoOptions);
          execute(
            renderTransaction(registry, demoOptions, seeds),
            demoOptions,
            memberEnv,
          );
          record.checks.at(-1).seed = 'PASS_TWO_RUNS_ROLLBACK';
        }
        save();
      }
      summary.push({
        login,
        schemas: account.schemas,
        connection: 'PASS',
        password: 'ASSIGNED',
        delivery: 'PENDING_BY_AXEL',
      });
    } catch {
      save();
      summary.push({
        login,
        connection: 'FAIL',
        password: record.password_status,
      });
      writeFileSync(
        join(directory, 'results.json'),
        JSON.stringify(summary, null, 2),
        { mode: 0o600 },
      );
      // Never return raw SQL, libpq error, password or recovery file content.
      return {
        status: 'PARTIAL',
        private_directory: directory,
        results: summary,
      };
    }
  }
  writeFileSync(
    join(directory, 'results.json'),
    JSON.stringify(summary, null, 2),
    { mode: 0o600 },
  );
  return { status: 'PASS', private_directory: directory, results: summary };
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    if (
      process.argv.length !== 5 ||
      process.argv[2] !== '--assign-initial-passwords' ||
      process.argv[3] !== '--psql'
    )
      throw new Error('EXPLICIT_INITIAL_PASSWORD_ASSIGNMENT_REQUIRED');
    const result = setupCredentials(process.argv[4]);
    console.log(JSON.stringify(result));
    if (result.status !== 'PASS') process.exitCode = 1;
  } catch (error) {
    console.error(
      /^[A-Z_]+$/.test(error.message) ? error.message : 'ACCESS_SETUP_FAILED',
    );
    process.exitCode = 1;
  }
}
