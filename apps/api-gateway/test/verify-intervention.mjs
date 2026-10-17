import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseEnv } from 'node:util';

// Solo filesystem y git de lectura. No conecta a PostgreSQL ni copia configuración.
const root = process.cwd();
const interventionBase = '7b15faeb421e7a54bfbf3e8250d6718023dcc3bb';
const git = (...args) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((item) => {
    const path = resolve(directory, item.name);
    if (item.isDirectory()) return walk(path);
    return /\.(ts|mjs|md|json)$/.test(item.name) ? [path] : [];
  });
}
const services = ['taxonomy-svc', 'catalog-svc', 'api-gateway'];
const files = services.flatMap((s) => walk(resolve(root, 'apps', s))).sort();
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sourceFiles = files.filter((f) => /\.(ts|mjs)$/.test(f));
const sources = Object.fromEntries(
  sourceFiles.map((f) => [
    relative(root, f).replaceAll('\\', '/'),
    sha(readFileSync(f)),
  ]),
);
const passwords = ['taxonomy', 'catalog'].map(
  (s) =>
    parseEnv(
      readFileSync(
        resolve(
          'C:/Users/marec/Desktop/G6-PostgresRuntime-Privado',
          s,
          '.env.local',
        ),
        'utf8',
      ),
    ).PGPASSWORD,
);
assert(passwords.every((p) => typeof p === 'string' && p.length > 0));
assert(
  files.every((f) =>
    passwords.every((p) => !readFileSync(f, 'utf8').includes(p)),
  ),
);
const gatewaySource = '98ad846a0046586cfe17cde5a2f9be8f101d8cb9';
const gatewayPaths = git(
  'ls-tree',
  '-r',
  '--name-only',
  gatewaySource,
  'apps/api-gateway',
).split('\n');
assert(
  gatewayPaths.every(
    (path) =>
      git('hash-object', '--path=' + path, path) ===
      git('rev-parse', gatewaySource + ':' + path),
  ),
);
const priorProbe = sha(
  readFileSync('apps/api-gateway/test/postgres-runtime.readonly.mjs'),
);
for (const s of ['taxonomy', 'catalog']) {
  const prior = JSON.parse(
    readFileSync(
      'apps/api-gateway/test/evidence/postgres-' + s + '-2026-10-16.json',
    ),
  );
  assert.equal(prior.probeSha256, priorProbe);
  assert.equal(prior.result, 'PASS_READONLY_DRIZZLE');
}
const reports = [
  'apps/taxonomy-svc/test/evidence/postgres-readonly-2026-10-16.json',
  'apps/catalog-svc/test/evidence/postgres-readonly-2026-10-16.json',
  'apps/api-gateway/test/evidence/marketplace-postgres-partial-2026-10-16.json',
];
const results = reports.map((file) => {
  const bytes = readFileSync(file);
  const report = JSON.parse(bytes);
  assert.equal(report.success, true);
  assert.equal(report.numFailedTests, 0);
  return {
    file,
    passed: report.numPassedTests,
    sha256: sha(bytes),
    startTime: report.startTime,
  };
});
const contract = resolve(root, '../docs/contratos/http/openapi.yaml');
const preexistingPaths = [
  'apps/api-gateway/INT-ASAP-MARKETPLACE.md',
  'apps/api-gateway/POSTGRES-RUNTIME-2026-10-16.md',
  'apps/api-gateway/test/marketplace.live.mjs',
  'apps/api-gateway/test/postgres-runtime.readonly.mjs',
  'apps/api-gateway/test/evidence/postgres-taxonomy-2026-10-16.json',
  'apps/api-gateway/test/evidence/postgres-catalog-2026-10-16.json',
  'apps/api-gateway/test/fixtures/marketplace-eligibility.cases.json',
];
const changedFiles = [
  ...new Set([
    ...git('diff', interventionBase, '--name-only').split('\n'),
    ...git('ls-files', '--others', '--exclude-standard').split('\n'),
  ]),
]
  .filter((f) => f && !preexistingPaths.includes(f))
  .sort();
assert(
  changedFiles.every(
    (f) =>
      ['package.json', 'package-lock.json'].includes(f) ||
      services.some((s) => f.startsWith('apps/' + s + '/')),
  ),
);
const packageJson = JSON.parse(readFileSync('package.json'));
const lockJson = JSON.parse(readFileSync('package-lock.json'));
assert.equal(packageJson.dependencies.pg, '8.23.1');
assert.equal(packageJson.dependencies['drizzle-orm'], '0.45.4');
assert.equal(packageJson.devDependencies['@types/pg'], '8.23.1');
assert.deepEqual(lockJson.packages[''].dependencies, packageJson.dependencies);
assert.deepEqual(
  lockJson.packages[''].devDependencies,
  packageJson.devDependencies,
);
const baselineLock = JSON.parse(
  git('show', interventionBase + ':package-lock.json'),
);
for (const [name, previous] of Object.entries(baselineLock.packages)) {
  if (!name) continue;
  for (const property of ['version', 'resolved', 'integrity'])
    assert.equal(lockJson.packages[name]?.[property], previous[property]);
}
const manifest = {
  date: new Date().toISOString(),
  node: process.version,
  branch: git('branch', '--show-current'),
  baseHead: interventionBase,
  snapshotHead: git('rev-parse', 'HEAD'),
  uncommitted: true,
  changedFiles,
  preexistingPathsPreserved: preexistingPaths,
  gatewaySource,
  taxonomySource: '4c1214862d106b66f9892bfc72e14450a6b31406',
  docsHead: execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: resolve(root, '../docs'),
    encoding: 'utf8',
  }).trim(),
  openapiSha256: sha(readFileSync(contract)),
  runtimePackages: Object.fromEntries(
    ['pg', 'drizzle-orm', '@types/pg'].map((name) => [
      name,
      JSON.parse(
        readFileSync(resolve(root, 'node_modules', name, 'package.json')),
      ).version,
    ]),
  ),
  sharedDependencyDeclaration: 'AUTHORIZED_AND_PINNED',
  packageJsonSha256: sha(readFileSync('package.json')),
  packageLockSha256: sha(readFileSync('package-lock.json')),
  checks: {
    secretScan: 'PASS',
    gatewayOriginalFilesUnchanged: 'PASS',
    priorProbeHashes: 'PASS',
    existingLockedVersionsPreserved: 'PASS',
  },
  results,
  sources,
  limits: [
    'Local uncommitted implementation; no deployment, G7 grant or G1 homologation.',
    'Zero active Catalog products observed. Positive real detail/variants NOT EXECUTED.',
    'Catalog real HTTP commercial routes intentionally return 503 pending D-CAT-05/06.',
    'Price filtering fails closed; product-level semantics/Pricing adapter pending.',
    'Clean npm ci and checks are recorded separately in dependencies-clean-2026-10-16.json.',
  ],
};
writeFileSync(
  'apps/api-gateway/test/evidence/intervention-manifest-2026-10-16.json',
  JSON.stringify(manifest, null, 2) + '\n',
);
console.log(
  JSON.stringify({
    result: 'PASS_LOCAL_MANIFEST',
    sources: Object.keys(sources).length,
    tests: results.map((r) => r.passed),
    secretScan: 'PASS',
    gatewayOriginalFiles: gatewayPaths.length,
  }),
);
