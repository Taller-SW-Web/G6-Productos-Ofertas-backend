import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const defaultBackendRoot = fileURLToPath(
  new URL('../../../../', import.meta.url),
);
const repository = 'Taller-SW-Web/G6-Productos-Ofertas-backend';

function git(directory, args) {
  return execFileSync('git', ['-C', directory, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function resolveCommitSha(directory, ref) {
  const target = ref ?? 'HEAD';
  if (typeof target !== 'string' || target.length === 0) {
    throw new Error('INVALID_GIT_REF');
  }
  return git(directory, [
    'rev-parse',
    '--verify',
    '--end-of-options',
    `${target}^{commit}`,
  ]).trim();
}

function readCommitFile(directory, commitSha, relativePath, { required }) {
  const objectSpec = `${commitSha}:${relativePath}`;
  try {
    git(directory, ['cat-file', '-e', objectSpec]);
  } catch {
    if (required) {
      throw new Error(`MISSING_FILE_AT_COMMIT:${relativePath}@${commitSha}`);
    }
    return '';
  }
  return git(directory, ['show', objectSpec]);
}

export function runPreflight({
  backendDir = defaultBackendRoot,
  docsDir,
  docsRef = 'HEAD',
  backendRef = 'HEAD',
} = {}) {
  if (!docsDir) {
    throw new Error(
      'Usage: node ops/azure/tests/h5-cd/preflight.mjs <docs-checkout> [docs-ref] [backend-ref]',
    );
  }

  const base_sha = resolveCommitSha(backendDir, backendRef);
  const docs_sha = resolveCommitSha(docsDir, docsRef);

  const readDocs = (file) =>
    readCommitFile(docsDir, docs_sha, file, { required: true });
  const readBackend = (file) =>
    readCommitFile(backendDir, base_sha, file, { required: false });

  const openapi = readDocs('contratos/http/openapi.yaml');
  const asyncapi = readDocs('contratos/eventos/asyncapi.yaml');
  const gateway = readBackend('apps/api-gateway/src/routing/g5-h5-routes.ts');
  const promotions = readBackend(
    'apps/promotions-svc/src/http/coupon-h5-controller.ts',
  );
  const inventory = readBackend(
    'apps/inventory-svc/src/inventory.controller.ts',
  );

  const routes = [
    ['INT-03', 'POST', '/cupones/consumos', "@Post('consumos')", promotions],
    [
      'INT-03',
      'POST',
      '/cupones/restauraciones',
      "@Post('restauraciones')",
      promotions,
    ],
    [
      'INT-09',
      'GET',
      '/cupones/operaciones/{operationId}',
      "@Get('operaciones/:operationId')",
      promotions,
    ],
    [
      'INT-09',
      'GET',
      '/inventario/reservas/{reservaId}/estado',
      "@Get('reservas/:reservaId/estado')",
      inventory,
    ],
  ].map(([capability_id, method, path, marker, provider]) => {
    const start = openapi.indexOf('\n  ' + path + ':');
    const contract_present =
      start >= 0 &&
      new RegExp('\n    ' + method.toLowerCase() + ':').test(
        openapi.slice(start, start + path.length + 30),
      );
    const provider_present =
      provider.includes(marker) &&
      gateway.includes("path: '" + '/api/v1' + path + "'");
    return {
      repo: repository,
      base_sha,
      docs_sha,
      capability_id,
      method,
      path: '/api/v1' + path,
      provider_present,
      contract_present,
      local_test_possible: provider_present && contract_present,
      feature_flag: 'GATEWAY_G5_H5_ENABLED',
      external_gate:
        'Evidence endpoint G5, G7 grants and approved isolated deployment',
      owner: 'Axel Cueva',
    };
  });

  const other = [
    [
      'SEC-CD-01',
      'workflow_dispatch',
      '.github/workflows/cd-services-azure.yml',
      'verify-environment-protection.sh',
      null,
      'Authorized same-SHA run, OCI digest, environment and private smoke runner',
    ],
    [
      'PERF-04',
      'POST',
      'apps/promotions-svc/test/performance/coupon-admission.k6.js',
      'perf04_admission_202_ms',
      routes[0].contract_present,
      'Vera runner interface, N01 release and seeded authorized lab',
    ],
    [
      'PERF-05',
      'R16',
      'ops/azure/service-bus/pilot.postgres.e2e-spec.ts',
      'PricingServiceBusRelay',
      asyncapi.includes('g6.price-audit.from.pricing'),
      'Authorized Service Bus R16 capture and load',
    ],
    [
      'PERF-05',
      'R18',
      'tests/h5/taxonomy-service-bus.postgres.e2e-spec.ts',
      'Taxonomy',
      asyncapi.includes('g6.catalog.from.taxonomy'),
      'Authorized R18 capture and load',
    ],
    [
      'RL-05',
      'TRACE',
      'ops/azure/apim/policies/operation-secured.xml',
      'rate-limit-by-key',
      null,
      'Castilla/Infra authorized APIM, private Gateway and full request traces',
    ],
  ].map(
    ([
      capability_id,
      method,
      path,
      marker,
      contract_present,
      external_gate,
    ]) => {
      const provider_present = readBackend(path).includes(marker);
      return {
        repo: repository,
        base_sha,
        docs_sha,
        capability_id,
        method,
        path,
        provider_present,
        contract_present,
        local_test_possible: provider_present,
        external_gate,
        owner: 'Axel Cueva',
      };
    },
  );

  return {
    repo: repository,
    source_mode: 'git-commit',
    base_sha,
    docs_sha,
    capabilities: [...routes, ...other],
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [docsDir, docsRef, backendRef] = process.argv.slice(2);
  const result = runPreflight({
    backendDir: process.env.PREFLIGHT_BACKEND_DIR || defaultBackendRoot,
    docsDir,
    docsRef,
    backendRef,
  });
  console.log(JSON.stringify(result, null, 2));
}
