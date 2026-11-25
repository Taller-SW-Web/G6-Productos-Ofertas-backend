import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const [docs, docsRef] = process.argv.slice(2);
if (!docs)
  throw new Error(
    'Usage: node ops/azure/tests/h5-cd/preflight.mjs <docs-checkout> [docs-ref]',
  );
const git = (directory, args) =>
  execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8' });
const read = (directory, file) =>
  readFileSync(resolve(directory, file), 'utf8');
const docs_sha = git(docs, [
  'rev-parse',
  '--verify',
  '--end-of-options',
  (docsRef ?? 'HEAD') + '^{commit}',
]).trim();
const readDocs = (file) =>
  docsRef ? git(docs, ['show', docs_sha + ':' + file]) : read(docs, file);
const openapi = readDocs('contratos/http/openapi.yaml');
const asyncapi = readDocs('contratos/eventos/asyncapi.yaml');
const gateway = read(root, 'apps/api-gateway/src/routing/g5-h5-routes.ts');
const promotions = read(
  root,
  'apps/promotions-svc/src/http/coupon-h5-controller.ts',
);
const inventory = read(root, 'apps/inventory-svc/src/inventory.controller.ts');
const base_sha = git(root, ['rev-parse', 'HEAD']).trim();
const repo = 'Taller-SW-Web/G6-Productos-Ofertas-backend';

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
    repo,
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
  ([capability_id, method, path, marker, contract_present, external_gate]) => {
    const provider_present = read(root, path).includes(marker);
    return {
      repo,
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

console.log(
  JSON.stringify(
    { repo, base_sha, docs_sha, capabilities: [...routes, ...other] },
    null,
    2,
  ),
);
