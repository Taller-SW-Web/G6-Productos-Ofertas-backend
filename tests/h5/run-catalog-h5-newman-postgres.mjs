import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

/**
 * H33 — Runner automatizado de PostgreSQL 17 descartable para las suites H5 de Catalog + Newman
 * (reutilizando la imagen fijada y el ciclo de vida seguro de tests/h5/run-catalog-bulk-inventory-postgres.mjs).
 *
 * - Aprovisiona PostgreSQL 17 en loopback efímero (127.0.0.1::5432) y base dedicada *_isolated.
 * - Crea roles propietarios y roles runtime no propietarios con mínimos privilegios:
 *     catalog_app, pricing_app, inventory_app.
 * - Aplica las migraciones oficiales de catalog, pricing e inventory.
 * - Ejecuta catalog-h5-equivalence.postgres.e2e-spec.ts y catalog-h5-newman-real.postgres.e2e-spec.ts.
 * - Verifica que 0 pruebas fueron omitidas silenciosamente (6/6 PASS).
 * - Limpia el contenedor en finally incluso ante errores.
 */

const exec = promisify(execFile);
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const containerName = `g6-h5-newman-pg17-${suffix}`;
const database = `h5_catalog_${suffix}_isolated`;
const adminPassword = randomUUID();
const runtimePassword = randomUUID();
const image =
  'postgres@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24';

const docsRoot = resolve(
  process.argv[2] ??
    process.env.G6_DOCS_ROOT ??
    process.env.G6_E2E_DOCS_PATH ??
    '../Productos-y-Ofertas-docs-poma-hito-5-pruebas-v2',
);
const keepEvidenceDir = process.env.G6_H5_KEEP_EVIDENCE_DIR
  ? resolve(process.env.G6_H5_KEEP_EVIDENCE_DIR)
  : '';
const vitestReportPath = keepEvidenceDir
  ? join(keepEvidenceDir, 'vitest-h5-real-report.json')
  : resolve(`.ci/h5-newman-pg17-${suffix}-vitest.json`);

const docker = (args, input) =>
  new Promise((resolveExec, rejectExec) => {
    const child = execFile(
      'docker',
      args,
      { timeout: 60000, windowsHide: true, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) rejectExec(new Error(`${err.message}\n${stderr}`));
        else resolveExec({ stdout, stderr });
      },
    );
    if (input !== undefined) {
      child.stdin?.write(input);
      child.stdin?.end();
    }
  });

async function psqlExec(containerId, user, sqlText) {
  await docker(
    [
      'exec',
      '-i',
      '-e',
      `PGPASSWORD=${user === 'postgres' ? adminPassword : runtimePassword}`,
      containerId,
      'psql',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      user,
      '-d',
      database,
    ],
    sqlText,
  );
}

let containerId;
try {
  if (keepEvidenceDir) mkdirSync(keepEvidenceDir, { recursive: true });
  else mkdirSync(resolve('.ci'), { recursive: true });

  const runRes = await docker([
    'run',
    '--detach',
    '--rm',
    '--label',
    'g6.h5.newman.pg17=1',
    '--name',
    containerName,
    '--publish',
    '127.0.0.1::5432',
    '--env',
    `POSTGRES_DB=${database}`,
    '--env',
    `POSTGRES_PASSWORD=${adminPassword}`,
    image,
  ]);
  containerId = runRes.stdout.trim();
  if (!/^[0-9a-f]{64}$/.test(containerId)) {
    throw new Error(
      'Docker no devolvio un ID valido de PostgreSQL 17 descartable.',
    );
  }

  const portOut = await docker(['port', containerId, '5432/tcp']);
  const port = /^127\.0\.0\.1:(\d+)\s*$/m.exec(portOut.stdout)?.[1];
  if (!port) {
    throw new Error(
      'PostgreSQL 17 descartable debe escuchar exclusivamente en 127.0.0.1.',
    );
  }

  let ready = false;
  for (let i = 0; i < 40 && !ready; i += 1) {
    try {
      await docker([
        'exec',
        containerId,
        'pg_isready',
        '-h',
        '127.0.0.1',
        '-U',
        'postgres',
        '-d',
        database,
      ]);
      ready = true;
    } catch {
      await delay(250);
    }
  }
  if (!ready)
    throw new Error('PostgreSQL 17 descartable no respondio pg_isready.');

  // 1) Roles propietarios y roles runtime no propietarios (catalog_app, pricing_app, inventory_app) + schemas + btree_gist
  await psqlExec(
    containerId,
    'postgres',
    `
    CREATE ROLE po_catalog_owner LOGIN PASSWORD '${runtimePassword}';
    CREATE ROLE catalog_app LOGIN PASSWORD '${runtimePassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    CREATE SCHEMA catalog AUTHORIZATION po_catalog_owner;

    CREATE ROLE po_pricing_owner LOGIN PASSWORD '${runtimePassword}';
    CREATE ROLE pricing_app LOGIN PASSWORD '${runtimePassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    CREATE SCHEMA pricing AUTHORIZATION po_pricing_owner;
    CREATE SCHEMA extensions;
    CREATE EXTENSION btree_gist SCHEMA extensions;
    GRANT USAGE ON SCHEMA extensions TO po_pricing_owner, pricing_app;

    CREATE ROLE po_inventory_owner LOGIN PASSWORD '${runtimePassword}';
    CREATE ROLE inventory_app LOGIN PASSWORD '${runtimePassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    CREATE SCHEMA inventory AUTHORIZATION po_inventory_owner;
    `,
  );

  // 2) Aplicar las 8 migraciones oficiales de catalog en orden con po_catalog_owner
  const catalogSqlPaths = [
    resolve('apps/catalog-svc/test/fixtures/0001_create_catalog.sql'),
    ...readdirSync(resolve('apps/catalog-svc/migrations'))
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .map((f) => resolve('apps/catalog-svc/migrations', f)),
  ];
  const candidateDir = resolve('apps/catalog-svc/migrations-candidate');
  if (existsSync(candidateDir)) {
    const walkSql = (dir) => {
      const out = [];
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walkSql(full));
        else if (entry.name.endsWith('.sql')) out.push(full);
      }
      return out.sort();
    };
    catalogSqlPaths.push(...walkSql(candidateDir));
  }
  for (const sqlPath of catalogSqlPaths) {
    await psqlExec(
      containerId,
      'po_catalog_owner',
      readFileSync(sqlPath, 'utf8'),
    );
  }

  // 3) Aplicar migracion oficial de pricing con po_pricing_owner
  const pricingSql = resolve('apps/pricing-svc/test/fixtures/pricing.sql');
  await psqlExec(
    containerId,
    'po_pricing_owner',
    readFileSync(pricingSql, 'utf8'),
  );

  // 4) Aplicar migraciones oficiales de inventory y transferir ownership a po_inventory_owner + permisos minimos a inventory_app
  const invInitial = resolve(
    'apps/catalog-svc/test/fixtures/inventory-initial.sql',
  );
  const invOps = resolve(
    'apps/catalog-svc/test/fixtures/inventory-operations.sql',
  );
  await psqlExec(containerId, 'postgres', readFileSync(invInitial, 'utf8'));
  await psqlExec(containerId, 'postgres', readFileSync(invOps, 'utf8'));
  await psqlExec(
    containerId,
    'postgres',
    `
    ALTER SCHEMA inventory OWNER TO po_inventory_owner;
    REVOKE ALL ON SCHEMA inventory FROM PUBLIC;
    GRANT USAGE ON SCHEMA inventory TO inventory_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA inventory TO inventory_app;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA inventory TO inventory_app;
    `,
  );

  // 5) Ejecutar ambas suites H5 productivas sobre el PG17 descartable con roles runtime
  const status = await new Promise((resolveStatus, rejectStatus) => {
    const child = spawn(
      process.execPath,
      [
        'node_modules/vitest/vitest.mjs',
        'run',
        '--config',
        'vitest.config.e2e.ts',
        'apps/catalog-svc/test/h5/catalog-h5-equivalence.postgres.e2e-spec.ts',
        'apps/catalog-svc/test/h5/catalog-h5-newman-real.postgres.e2e-spec.ts',
        '--maxWorkers=1',
        '--reporter=verbose',
        '--reporter=json',
        `--outputFile=${vitestReportPath}`,
      ],
      {
        stdio: 'inherit',
        env: {
          ...process.env,
          CATALOG_H5_DISPOSABLE_PG: '1',
          PGHOST: '127.0.0.1',
          PGPORT: port,
          PGDATABASE: database,
          PGUSER: 'catalog_app',
          PGPASSWORD: runtimePassword,
          PGADMIN_PASSWORD: adminPassword,
          PRICING_RUNTIME_USER: 'pricing_app',
          PRICING_RUNTIME_PASSWORD: runtimePassword,
          INVENTORY_RUNTIME_USER: 'inventory_app',
          INVENTORY_RUNTIME_PASSWORD: runtimePassword,
          G6_DOCS_ROOT: docsRoot,
          ...(keepEvidenceDir
            ? { G6_H5_KEEP_EVIDENCE_DIR: keepEvidenceDir }
            : {}),
        },
      },
    );
    child.once('error', rejectStatus);
    child.once('exit', (code) => resolveStatus(code ?? 1));
  });

  if (status !== 0) {
    process.exitCode = status;
  } else {
    // 6) Verificar estrictamente que NO hubo omisiones silenciosas (6/6 PASS, 0 skipped, 0 failed)
    const report = JSON.parse(readFileSync(vitestReportPath, 'utf8'));
    const tests = (report.testResults ?? []).flatMap(
      (f) => f.assertionResults ?? [],
    );
    const passed = tests.filter((t) => t.status === 'passed').length;
    const skipped = tests.filter((t) =>
      ['pending', 'skipped', 'todo'].includes(t.status),
    ).length;
    console.log(
      `[H33 PG17 Runner] Suites verificadas: ${passed} aprobadas, ${skipped} omitidas, ${tests.length} totales`,
    );
    if (passed !== 6 || skipped !== 0 || report.numFailedTests !== 0) {
      throw new Error(
        `H33: Conteo inesperado en suites PG17 (esperado 6 passed / 0 skipped, obtenido ${passed} passed / ${skipped} skipped).`,
      );
    }
  }
} catch (err) {
  process.exitCode = 1;
  const safeMsg = (err instanceof Error ? err.message : String(err))
    .replaceAll(adminPassword, '[redactado]')
    .replaceAll(runtimePassword, '[redactado]');
  console.error(safeMsg);
} finally {
  if (/^[0-9a-f]{64}$/.test(containerId ?? '')) {
    try {
      await docker(['stop', containerId]);
    } catch {
      console.error(
        `No se pudo detener el PostgreSQL 17 descartable ${containerName}`,
      );
      process.exitCode = 1;
    }
  }
}
