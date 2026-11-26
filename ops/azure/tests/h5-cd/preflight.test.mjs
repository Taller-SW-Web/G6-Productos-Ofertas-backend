import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runPreflight } from './preflight.mjs';

const preflightScript = fileURLToPath(
  new URL('./preflight.mjs', import.meta.url),
);

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

async function writeRepoFiles(repoDir, files) {
  for (const [relativePath, content] of Object.entries(files)) {
    const fullPath = join(repoDir, relativePath);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content, 'utf8');
  }
}

async function initRepo(root, name) {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  git(dir, ['init', '-b', 'master']);
  git(dir, ['config', 'user.email', 'test@example.invalid']);
  git(dir, ['config', 'user.name', 'Test User']);
  return dir;
}

function commitAll(repoDir, message) {
  git(repoDir, ['add', '.']);
  git(repoDir, ['commit', '-m', message]);
  return git(repoDir, ['rev-parse', 'HEAD']);
}

const fullDocsFiles = {
  'contratos/http/openapi.yaml': [
    'openapi: 3.1.0',
    'paths:',
    '  /cupones/consumos:',
    '    post:',
    '      operationId: consumirCupon',
    '  /cupones/restauraciones:',
    '    post:',
    '      operationId: restaurarCupon',
    '  /cupones/operaciones/{operationId}:',
    '    get:',
    '      operationId: consultarOperacionCupon',
    '  /inventario/reservas/{reservaId}/estado:',
    '    get:',
    '      operationId: consultarEstadoReserva',
    '',
  ].join('\n'),
  'contratos/eventos/asyncapi.yaml': [
    'asyncapi: 2.6.0',
    'channels:',
    '  g6.price-audit.from.pricing: {}',
    '  g6.catalog.from.taxonomy: {}',
    '',
  ].join('\n'),
};

const partialDocsFiles = {
  'contratos/http/openapi.yaml': [
    'openapi: 3.1.0',
    'paths:',
    '  /cupones/restauraciones:',
    '    post:',
    '      operationId: restaurarCupon',
    '',
  ].join('\n'),
  'contratos/eventos/asyncapi.yaml': [
    'asyncapi: 2.6.0',
    'channels:',
    '  g6.price-audit.from.pricing: {}',
    '',
  ].join('\n'),
};

const partialBackendFiles = {
  'apps/api-gateway/src/routing/g5-h5-routes.ts':
    "export const routes = [{ path: '/api/v1/cupones/restauraciones' }];\n",
  'apps/promotions-svc/src/http/coupon-h5-controller.ts':
    "@Post('restauraciones')\n",
  'apps/inventory-svc/src/inventory.controller.ts': 'export class Empty {}\n',
  '.github/workflows/cd-services-azure.yml':
    'verify-environment-protection.sh\n',
  'ops/azure/service-bus/pilot.postgres.e2e-spec.ts':
    'PricingServiceBusRelay\n',
  'tests/h5/taxonomy-service-bus.postgres.e2e-spec.ts': 'Taxonomy\n',
  'ops/azure/apim/policies/operation-secured.xml': '<rate-limit-by-key />\n',
};

const fullBackendFiles = {
  ...partialBackendFiles,
  'apps/api-gateway/src/routing/g5-h5-routes.ts': [
    "path: '/api/v1/cupones/consumos'",
    "path: '/api/v1/cupones/restauraciones'",
    "path: '/api/v1/cupones/operaciones/{operationId}'",
    "path: '/api/v1/inventario/reservas/{reservaId}/estado'",
    '',
  ].join('\n'),
  'apps/promotions-svc/src/http/coupon-h5-controller.ts': [
    "@Post('consumos')",
    "@Post('restauraciones')",
    "@Get('operaciones/:operationId')",
    '',
  ].join('\n'),
  'apps/inventory-svc/src/inventory.controller.ts':
    "@Get('reservas/:reservaId/estado')\n",
  'apps/promotions-svc/test/performance/coupon-admission.k6.js':
    'const admission = "perf04_admission_202_ms";\n',
};

async function createFixtureRepos() {
  const root = await mkdtemp(join(tmpdir(), 'g6-preflight-test-'));
  const docsDir = await initRepo(root, 'docs');
  await writeRepoFiles(docsDir, partialDocsFiles);
  const docsCommit1 = commitAll(docsDir, 'docs: partial contracts');
  await writeRepoFiles(docsDir, fullDocsFiles);
  const docsCommit2 = commitAll(docsDir, 'docs: full contracts');

  const backendDir = await initRepo(root, 'backend');
  await writeRepoFiles(backendDir, partialBackendFiles);
  const backendCommit1 = commitAll(backendDir, 'backend: partial capabilities');
  await writeRepoFiles(backendDir, fullBackendFiles);
  const backendCommit2 = commitAll(backendDir, 'backend: full capabilities');

  return {
    root,
    docsDir,
    backendDir,
    docsCommit1,
    docsCommit2,
    backendCommit1,
    backendCommit2,
  };
}

test('reads exact committed bytes even when working trees have uncommitted modifications or new files', async () => {
  const fixture = await createFixtureRepos();
  try {
    const clean = runPreflight({
      backendDir: fixture.backendDir,
      docsDir: fixture.docsDir,
    });
    assert.equal(clean.source_mode, 'git-commit');
    assert.equal(clean.base_sha, fixture.backendCommit2);
    assert.equal(clean.docs_sha, fixture.docsCommit2);
    assert.ok(
      clean.capabilities.every((entry) => entry.provider_present === true),
    );
    assert.ok(
      clean.capabilities
        .filter((entry) => entry.contract_present !== null)
        .every((entry) => entry.contract_present === true),
    );

    // Modify committed files on disk AFTER the commit and add an untracked file in scope.
    await writeRepoFiles(fixture.backendDir, {
      'apps/promotions-svc/src/http/coupon-h5-controller.ts':
        '// dirty working tree stripped markers\n',
      'apps/promotions-svc/test/performance/untracked-extra.k6.js':
        'perf04_admission_202_ms\n',
    });
    await writeRepoFiles(fixture.docsDir, {
      'contratos/http/openapi.yaml': 'openapi: 3.1.0\npaths: {}\n',
    });

    const afterDirty = runPreflight({
      backendDir: fixture.backendDir,
      docsDir: fixture.docsDir,
    });
    assert.equal(afterDirty.base_sha, fixture.backendCommit2);
    assert.equal(afterDirty.docs_sha, fixture.docsCommit2);
    assert.deepEqual(afterDirty, clean);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('evaluates exact bytes for refs different from HEAD in both Backend and Docs', async () => {
  const fixture = await createFixtureRepos();
  try {
    const result = runPreflight({
      backendDir: fixture.backendDir,
      docsDir: fixture.docsDir,
      docsRef: 'HEAD~1',
      backendRef: fixture.backendCommit1,
    });
    assert.equal(result.base_sha, fixture.backendCommit1);
    assert.equal(result.docs_sha, fixture.docsCommit1);

    const consumos = result.capabilities.find(
      (entry) => entry.path === '/api/v1/cupones/consumos',
    );
    const restauraciones = result.capabilities.find(
      (entry) => entry.path === '/api/v1/cupones/restauraciones',
    );
    const perf04 = result.capabilities.find(
      (entry) => entry.capability_id === 'PERF-04',
    );
    const r18 = result.capabilities.find(
      (entry) => entry.capability_id === 'PERF-05' && entry.method === 'R18',
    );

    assert.equal(consumos.provider_present, false);
    assert.equal(consumos.contract_present, false);
    assert.equal(consumos.local_test_possible, false);
    assert.equal(restauraciones.provider_present, true);
    assert.equal(restauraciones.contract_present, true);
    assert.equal(perf04.provider_present, false);
    assert.equal(r18.contract_present, false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('CLI supports explicit refs and fails explicitly on nonexistent refs', async () => {
  const fixture = await createFixtureRepos();
  try {
    const stdout = execFileSync(
      process.execPath,
      [preflightScript, fixture.docsDir, fixture.docsCommit1, 'HEAD~1'],
      {
        encoding: 'utf8',
        env: { ...process.env, PREFLIGHT_BACKEND_DIR: fixture.backendDir },
      },
    );
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.base_sha, fixture.backendCommit1);
    assert.equal(parsed.docs_sha, fixture.docsCommit1);

    assert.throws(() =>
      runPreflight({
        backendDir: fixture.backendDir,
        docsDir: fixture.docsDir,
        docsRef: 'refs/heads/does-not-exist',
      }),
    );
    assert.throws(() =>
      runPreflight({
        backendDir: fixture.backendDir,
        docsDir: fixture.docsDir,
        backendRef: '0'.repeat(40),
      }),
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
