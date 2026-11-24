import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const suffix = randomUUID().replaceAll('-', '');
const name = 'g6-taxonomy-h5-' + suffix;
const database = 'g6_taxonomy_h5_test_' + suffix;
const password = randomUUID();
const docs = resolve(process.argv[2] ?? '../G6-Productos-Ofertas-docs');
const image =
  'postgres@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24';
const docker = (args) =>
  exec('docker', args, { timeout: 60000, windowsHide: true });

let containerId;
try {
  const result = await docker([
    'run',
    '--detach',
    '--rm',
    '--name',
    name,
    '--publish',
    '127.0.0.1::5432',
    '--env',
    'POSTGRES_DB=' + database,
    '--env',
    'POSTGRES_PASSWORD=' + password,
    image,
  ]);
  containerId = result.stdout.trim();
  if (!/^[0-9a-f]{64}$/.test(containerId))
    throw new Error('Docker no devolvió el ID del PostgreSQL descartable');
  const portMapping = await docker(['port', containerId, '5432/tcp']);
  const port = /^127\.0\.0\.1:(\d+)\s*$/.exec(portMapping.stdout)?.[1];
  if (!port)
    throw new Error('El PostgreSQL descartable debe escuchar solo en loopback');
  let ready = false;
  for (let attempt = 0; attempt < 40 && !ready; attempt++) {
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
  if (!ready) throw new Error('PostgreSQL descartable no disponible');
  const status = await new Promise((resolveStatus, reject) => {
    const child = spawn(
      process.execPath,
      [
        'node_modules/vitest/vitest.mjs',
        'run',
        '--config',
        'vitest.config.e2e.ts',
        'tests/h5/taxonomy-service-bus.postgres.e2e-spec.ts',
        '--maxWorkers=1',
        '--reporter=verbose',
      ],
      {
        stdio: 'inherit',
        env: {
          ...process.env,
          G6_TAXONOMY_H5_POSTGRES_TESTS: '1',
          G6_TAXONOMY_H5_POSTGRES_URL:
            'postgresql://postgres:' +
            password +
            '@127.0.0.1:' +
            port +
            '/' +
            database,
          G6_E2E_DOCS_PATH: docs,
          MESSAGING_PROVIDER: 'AZURE_SERVICE_BUS',
          CATALOG_H5_DESTINATIONS: 'g6.taxonomy.from.catalog',
        },
      },
    );
    child.once('error', reject);
    child.once('exit', (code) => resolveStatus(code ?? 1));
  });
  process.exitCode = status;
} catch (error) {
  process.exitCode = 1;
  const reason = (
    error instanceof Error ? error.message : String(error)
  ).replaceAll(password, '[redactado]');
  console.error(reason);
} finally {
  if (/^[0-9a-f]{64}$/.test(containerId ?? '')) {
    try {
      await docker(['stop', containerId]);
    } catch {
      console.error('No se pudo detener el PostgreSQL descartable ' + name);
      process.exitCode = 1;
    }
  }
}
