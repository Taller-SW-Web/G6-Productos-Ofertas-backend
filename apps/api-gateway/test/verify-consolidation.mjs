import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';

const git = (...args) =>
  execFileSync('git', args, { encoding: 'utf8', windowsHide: true }).trim();
const source = {
  cueva: '68c96a77ab8c77b1f218d6283de7e1f4efa45e4f',
  castilla: 'fbbb74a528c73989c83f53e27690bcfcba966308',
  master: '24227527c632be4f3b8de612954328904ea57de0',
};
const files = (ref) =>
  git('ls-tree', '-r', '--name-only', ref, 'apps/api-gateway')
    .split('\n')
    .filter(Boolean);
const cueva = files(source.cueva),
  castilla = files(source.castilla);
const adapted = new Set([
  'apps/api-gateway/README.md',
  'apps/api-gateway/AUDITORIA-H01-H03.md',
]);
const imported = new Set([
  'apps/api-gateway/test/marketplace.live.mjs',
  'apps/api-gateway/test/marketplace.postgres.e2e-spec.ts',
  'apps/api-gateway/test/fixtures/marketplace-eligibility.cases.json',
]);
const inventory = [...new Set([...cueva, ...castilla])].sort().map((path) => {
  const cuevaBlob = cueva.includes(path)
    ? git('rev-parse', `${source.cueva}:${path}`)
    : null;
  const castillaBlob = castilla.includes(path)
    ? git('rev-parse', `${source.castilla}:${path}`)
    : null;
  const workingBlob = existsSync(path)
    ? git('hash-object', `--path=${path}`, path)
    : null;
  let decision;
  if (cuevaBlob && !adapted.has(path)) {
    assert.equal(workingBlob, cuevaBlob, `Lost cueva correction: ${path}`);
    decision =
      castillaBlob === cuevaBlob
        ? 'IDENTICAL_PRESERVED'
        : 'LATEST_CUEVA_PRESERVED';
  } else if (cuevaBlob) {
    assert.ok(workingBlob, `Missing documentation: ${path}`);
    decision = 'DOCUMENTATION_EXTENDED';
  } else if (imported.has(path)) {
    assert.ok(workingBlob, `Missing Marketplace tool: ${path}`);
    if (!path.endsWith('marketplace.postgres.e2e-spec.ts'))
      assert.equal(workingBlob, castillaBlob);
    decision = path.endsWith('marketplace.postgres.e2e-spec.ts')
      ? 'MARKETPLACE_TEST_PORTABLE_CONFIGURATION'
      : 'MARKETPLACE_TOOL_PRESERVED';
  } else {
    assert.equal(
      workingBlob,
      null,
      `Historical evidence unexpectedly copied: ${path}`,
    );
    decision = 'HISTORICAL_DOCUMENT_OR_PRIVATE_PROBE_RETAINED_AT_SOURCE';
  }
  return {
    path,
    cueva_blob: cuevaBlob,
    castilla_blob: castillaBlob,
    working_blob: workingBlob,
    decision,
  };
});

assert.equal(git('branch', '--show-current'), 'cueva');
assert.equal(
  git(
    'diff',
    source.cueva,
    source.castilla,
    '--name-only',
    'apps/api-gateway/src',
  ),
  [
    'apps/api-gateway/src/routing/gateway-proxy.ts',
    'apps/api-gateway/src/routing/streamed-request.ts',
  ].join('\n'),
);
for (const file of ['package.json', 'package-lock.json']) {
  assert.equal(
    git('hash-object', `--path=${file}`, file),
    git('rev-parse', `${source.cueva}:${file}`),
    'SHARED_DEPENDENCIES_CHANGED',
  );
}
const routes = readFileSync(
  'apps/api-gateway/src/routing/contract-routes.ts',
  'utf8',
);
assert.equal((routes.match(/operationId:/g) || []).length, 135);
const report = {
  result: 'PASS_FILE_COMPARISON',
  captured_at: new Date().toISOString(),
  sources: source,
  openapi_blob: 'f64bfe9a097b2a0f74c2600988305443d92f640e',
  operation_count: 135,
  shared_dependencies_modified: false,
  runtime_preserved_from_latest_cueva: true,
  inventory,
  limits: [
    'File comparison is not test execution, authenticated integration, homologation or deployment.',
    'Historical castilla evidence is linked at its immutable source, not reissued as current results.',
    'Local DATA work is excluded from the Gateway publication.',
  ],
};
const output = 'apps/api-gateway/test/evidence/consolidation-2026-10-16.json';
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
console.log(
  JSON.stringify({
    result: report.result,
    compared_paths: inventory.length,
    latest_runtime: 'PRESERVED',
    operation_count: 135,
    sha256: createHash('sha256').update(readFileSync(output)).digest('hex'),
  }),
);
