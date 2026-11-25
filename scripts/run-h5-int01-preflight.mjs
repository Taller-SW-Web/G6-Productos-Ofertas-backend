import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  CONTRACT_OPERATIONS,
  DOCS_SHA,
} from '../apps/catalog-svc/test/h5/int01-contract-oracles.mjs';
import { assertSafeEvidenceText } from '../apps/catalog-svc/test/h5/evidence-security.mjs';
import {
  evidenceByLevel,
  int01L1IndexStatus,
  int01L1ReportIntegrity,
} from './int01-preflight-coverage.mjs';

const docsSha = DOCS_SHA;
const scenariosPath = 'apps/catalog-svc/test/h5/int01-scenarios.json';
const outputPath = resolve(
  process.env.G6_H5_INT01_PREFLIGHT_OUTPUT ??
    'test-results/h5/int01-preflight-and-coverage.json',
);
const indexPath = `${outputPath}.index.json`;
const sourceShaResult = spawnSync('git', ['rev-parse', 'HEAD'], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'ignore'],
});
const masterShaResult = spawnSync('git', ['rev-parse', 'origin/master'], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'ignore'],
});
const statusResult = spawnSync('git', ['diff', '--quiet', 'HEAD'], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'ignore'],
});
const sourceSha =
  sourceShaResult.status === 0 ? sourceShaResult.stdout.trim() : null;
const masterSha =
  masterShaResult.status === 0 ? masterShaResult.stdout.trim() : null;
const worktreeDirty = statusResult.status !== 0;
const scenarios = JSON.parse(await readFile(scenariosPath, 'utf8'));

const providerSources = {
  'catalog-svc': [
    'apps/catalog-svc/src/catalog-query.controller.ts',
    'apps/catalog-svc/src/catalog-mutation.controller.ts',
    'apps/catalog-svc/src/commercial.controller.ts',
  ],
  'pricing-svc': [
    'apps/pricing-svc/src/http/pricing-read.controller.ts',
    'apps/pricing-svc/src/http/pricing-write.controller.ts',
  ],
  'inventory-svc': ['apps/inventory-svc/src/inventory.controller.ts'],
};
const providerOwners = {
  'catalog-svc': 'Poma/Catalog',
  'pricing-svc': 'Vera',
  'inventory-svc': 'Taco',
};
const extraOperations = [
  {
    id: 'catalog-variant-list',
    method: 'GET',
    path: '/productos/{productoId}/variantes',
    provider: 'catalog-svc',
  },
];

function readAt(ref, path) {
  const result = spawnSync('git', ['show', `${ref}:${path}`], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return result.status === 0 ? result.stdout : null;
}

function normalizePath(path) {
  return (
    path
      .split('?')[0]
      .replace(/^\/api\/v1/, '')
      .replace(/:([A-Za-z0-9_]+)/g, '{$1}')
      .replace(/\/$/, '') || '/'
  );
}

function routesFromSources(sources) {
  const routes = [];
  for (const [sourcePath, text] of sources) {
    if (!text) continue;
    const base = /@Controller\(['"]([^'"]+)['"]\)/.exec(text)?.[1];
    if (!base) continue;
    const decorator = /@(Get|Post|Patch)\s*\(\s*(?:['"]([^'"]*)['"]\s*)?\)/g;
    for (const match of text.matchAll(decorator)) {
      const routePath =
        `/${base.replace(/^\//, '')}/${match[2] ?? ''}`.replace(/\/+$/, '') ||
        '/';
      routes.push({
        method: match[1].toUpperCase(),
        path: normalizePath(routePath),
        source_path: sourcePath,
      });
    }
  }
  return routes;
}

function collectRoutes(ref) {
  const sources = Object.entries(providerSources).flatMap(([provider, paths]) =>
    paths.map((path) => [provider, path, readAt(ref, path)]),
  );
  const byProvider = {};
  for (const [provider, path, text] of sources) {
    byProvider[provider] ??= [];
    if (text) byProvider[provider].push([path, text]);
  }
  return Object.fromEntries(
    Object.entries(byProvider).map(([provider, list]) => [
      provider,
      routesFromSources(list),
    ]),
  );
}

const masterRoutes = masterSha ? collectRoutes(masterSha) : {};
const headRoutes = sourceSha ? collectRoutes(sourceSha) : {};
const contractOperations = [
  ...CONTRACT_OPERATIONS.map((operation) => ({
    ...operation,
    provider: operation.owner,
  })),
  ...extraOperations,
];
const capabilities = contractOperations.map((operation) => {
  const expectedPath = normalizePath(operation.path);
  const find = (routes) =>
    routes[operation.provider]?.find(
      (route) =>
        route.method === operation.method && route.path === expectedPath,
    );
  const master = find(masterRoutes);
  const head = find(headRoutes);
  return {
    operation_id: operation.id,
    method: operation.method,
    path: operation.path,
    provider: operation.provider,
    owner: providerOwners[operation.provider],
    contract_success_status: operation.success ?? null,
    contract_statuses: operation.statuses ?? [],
    master_controller: master?.source_path ?? null,
    master_capability: master
      ? 'PRESENT_IN_PINNED_ORIGIN_MASTER'
      : 'NOT_VERIFIED_IN_PINNED_ORIGIN_MASTER',
    head_controller: head?.source_path ?? null,
    head_capability: head ? 'PRESENT' : 'NOT_FOUND',
  };
});

const scenarioOperationMap = {
  'INT01-SIMPLE-COMPLETO': [
    'catalog-preparation-read',
    'pricing-effective-read',
    'inventory-availability-read',
  ],
  'INT01-VARIANTES-CANAL-GLOBAL': [
    'catalog-preparation-read',
    'pricing-effective-read',
    'inventory-availability-read',
  ],
  'INT01-PRODUCTO-INACTIVO': ['catalog-commercial-list'],
  'INT01-VARIANTE-DESACTIVADA': ['catalog-variant-list'],
  'INT01-PRECIO-AUSENTE': [
    'catalog-preparation-read',
    'pricing-effective-read',
    'inventory-availability-read',
  ],
  'INT01-STOCK-NO-OBSERVADO': [
    'catalog-preparation-read',
    'pricing-effective-read',
    'inventory-availability-read',
  ],
  'INT01-SKU-NO-VENDIBLE': ['catalog-commercial-list'],
  'INT01-CATEGORIA-INVALIDA': ['catalog-product-create'],
  'INT01-MARCA-INVALIDA': ['catalog-product-create'],
  'INT01-MAESTRO-VERSION-OBSOLETA': ['catalog-product-edit'],
  'INT01-VERSION-SKU-CAMBIADO': ['catalog-product-edit'],
  'INT01-ACTIVACION-TRAS-PREPARACION': [
    'catalog-product-activate',
    'catalog-preparation-read',
    'pricing-effective-read',
    'inventory-availability-read',
  ],
  'INT01-STOCK-NO-NEGATIVO': ['inventory-availability-read'],
  'INT01-PROVIDER-PRICING-NO-DISPONIBLE': [
    'catalog-preparation-read',
    'pricing-effective-read',
  ],
  'INT01-PROVIDER-INVENTORY-NO-DISPONIBLE': [
    'catalog-preparation-read',
    'inventory-availability-read',
  ],
  'INT01-IDENTIDAD-SCOPE-DENEGADO': [
    'catalog-commercial-list',
    'pricing-effective-read',
    'inventory-availability-read',
  ],
  'INT01-AISLAMIENTO-IDENTIDAD-CLIENTE': [
    'catalog-commercial-list',
    'pricing-effective-read',
    'inventory-availability-read',
  ],
  'INT01-ASYNC-PENDING-COMPLETED': [
    'catalog-preparation-retry',
    'catalog-preparation-read',
    'pricing-effective-read',
    'inventory-availability-read',
  ],
  'INT01-ASYNC-PENDING-REJECTED': [
    'catalog-preparation-retry',
    'catalog-preparation-read',
    'pricing-effective-read',
  ],
};
const ownersByScenario = {
  'INT01-SIMPLE-COMPLETO': ['Poma/Catalog', 'Vera/Pricing', 'Taco/Inventory'],
  'INT01-VARIANTES-CANAL-GLOBAL': [
    'Poma/Catalog',
    'Vera/Pricing',
    'Taco/Inventory',
  ],
  'INT01-PRODUCTO-INACTIVO': ['Poma/Catalog'],
  'INT01-VARIANTE-DESACTIVADA': ['Poma/Catalog'],
  'INT01-PRECIO-AUSENTE': ['Poma/Catalog', 'Vera/Pricing', 'Taco/Inventory'],
  'INT01-STOCK-NO-OBSERVADO': [
    'Poma/Catalog',
    'Vera/Pricing',
    'Taco/Inventory',
  ],
  'INT01-SKU-NO-VENDIBLE': ['Poma/Catalog'],
  'INT01-CATEGORIA-INVALIDA': ['Poma/Catalog', 'López/Taxonomy fixture'],
  'INT01-MARCA-INVALIDA': ['Poma/Catalog', 'López/Taxonomy fixture'],
  'INT01-MAESTRO-VERSION-OBSOLETA': ['Poma/Catalog', 'López/Taxonomy'],
  'INT01-VERSION-SKU-CAMBIADO': ['Poma/Catalog'],
  'INT01-ACTIVACION-TRAS-PREPARACION': [
    'Poma/Catalog',
    'Vera/Pricing',
    'Taco/Inventory',
  ],
  'INT01-STOCK-NO-NEGATIVO': ['Taco/Inventory', 'Poma/Catalog'],
  'INT01-PROVIDER-PRICING-NO-DISPONIBLE': ['Poma/Catalog', 'Vera/Pricing'],
  'INT01-PROVIDER-INVENTORY-NO-DISPONIBLE': ['Poma/Catalog', 'Taco/Inventory'],
  'INT01-IDENTIDAD-SCOPE-DENEGADO': [
    'Poma/Catalog',
    'Vera/Pricing',
    'Taco/Inventory',
    'G7 identity owner',
  ],
  'INT01-AISLAMIENTO-IDENTIDAD-CLIENTE': [
    'Poma/Catalog',
    'Vera/Pricing',
    'Taco/Inventory',
    'G7 identity owner',
  ],
  'INT01-ASYNC-PENDING-COMPLETED': [
    'Poma/Catalog',
    'Vera/Pricing',
    'Taco/Inventory',
    'Service Bus owner',
  ],
  'INT01-ASYNC-PENDING-REJECTED': [
    'Poma/Catalog',
    'Vera/Pricing',
    'Taco/Inventory',
    'Service Bus owner',
  ],
};
const dependenciesByScenario = {
  'INT01-SIMPLE-COMPLETO': [
    '#262 integrado en master para runtime Outbox/relay/consumidores',
    'Pricing e Inventory iniciados desde el mismo SHA',
    'identidad de servicio autorizada',
    'seeders propietarios de Precio e Inventario',
    'correlación end-to-end',
  ],
  'INT01-VARIANTES-CANAL-GLOBAL': [
    '#262 integrado en master',
    'Pricing fallback por canal',
    'seeders propietarios de Precio/Inventario',
    'identidad autorizada y correlación',
  ],
  'INT01-PRODUCTO-INACTIVO': [],
  'INT01-VARIANTE-DESACTIVADA': [
    'estado inactivo y oráculo comercial de variante',
  ],
  'INT01-PRECIO-AUSENTE': [
    'Pricing real',
    'Inventory real',
    'seeder autorizado de Inventory',
    '#262 para preparación asíncrona',
  ],
  'INT01-STOCK-NO-OBSERVADO': [
    'Pricing real',
    'Inventory real',
    '#262 para preparación asíncrona',
  ],
  'INT01-SKU-NO-VENDIBLE': [],
  'INT01-CATEGORIA-INVALIDA': [
    'Taxonomy fixture autorizado solo para prueba local',
  ],
  'INT01-MARCA-INVALIDA': [
    'Taxonomy fixture autorizado solo para prueba local',
  ],
  'INT01-MAESTRO-VERSION-OBSOLETA': [
    'Taxonomy debe exponer versión/revisión obsoleta mediante harness autorizado',
  ],
  'INT01-VERSION-SKU-CAMBIADO': [],
  'INT01-ACTIVACION-TRAS-PREPARACION': [
    '#262 integrado en master',
    'seeders de Pricing/Inventory',
    'oráculo de activación propietario',
  ],
  'INT01-STOCK-NO-NEGATIVO': [
    'Inventory seeder y mutación de prueba autorizados por Taco',
  ],
  'INT01-PROVIDER-PRICING-NO-DISPONIBLE': [
    'Pricing real detenable en sandbox',
    '#262 runtime integrado',
  ],
  'INT01-PROVIDER-INVENTORY-NO-DISPONIBLE': [
    'Inventory real detenable en sandbox',
    '#262 runtime integrado',
  ],
  'INT01-IDENTIDAD-SCOPE-DENEGADO': [
    'identidad negativa autorizada en los tres servicios',
  ],
  'INT01-AISLAMIENTO-IDENTIDAD-CLIENTE': [
    'dos identidades sintéticas y grants de dominio',
  ],
  'INT01-ASYNC-PENDING-COMPLETED': [
    '#262 integrado',
    'consumidores Pricing/Inventory reales',
    'seeders autorizados',
  ],
  'INT01-ASYNC-PENDING-REJECTED': [
    '#262 integrado',
    'rechazo autoritativo de Pricing',
    'seeders autorizados',
  ],
};
let l0Evidence = {
  status: 'NOT_RUN',
  execution: 'NOT_EXECUTED',
  path: null,
  sha256: null,
};
try {
  const path = resolve('apps/catalog-svc/test/h5/reports/int01.json');
  const bytes = await readFile(path);
  const summary = JSON.parse(bytes.toString('utf8'));
  l0Evidence = {
    status:
      summary.suite === 'INT01_CONTRACT' &&
      summary.total === 35 &&
      summary.passed === 35 &&
      summary.failed === 0 &&
      summary.skipped === 0
        ? 'PASS'
        : 'FAIL',
    execution: 'EXECUTED',
    path: 'apps/catalog-svc/test/h5/reports/int01.json',
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
} catch {
  /* no L0 execution evidence yet */
}
let l1Report = null;
let l1ReportAvailable = false;
try {
  l1Report = JSON.parse(
    await readFile(resolve('test-results/h5/int01-l1-summary.json'), 'utf8'),
  );
  l1ReportAvailable = true;
} catch {
  /* no L1 run yet */
}
const l1Integrity = int01L1ReportIntegrity(l1Report, sourceSha);
if (!l1Integrity.valid) l1Report = null;
const l1ById = new Map(
  (l1Report?.cases ?? []).map((item) => [item.scenario_id, item]),
);
const scenarioCases = scenarios.map((scenario) => {
  const authSubcase =
    scenario.id === 'INT01-IDENTIDAD-SCOPE-DENEGADO'
      ? l1ById.get('INT01-CATALOG-AUTH-SUBCASE')
      : null;
  const l1 = l1ById.get(scenario.id) ?? authSubcase;
  const l1State =
    scenario.id === 'INT01-VARIANTE-DESACTIVADA' && l1?.status === 'PASS'
      ? 'PARTIAL'
      : authSubcase?.status === 'PASS'
        ? 'PARTIAL'
        : l1?.status === 'PASS' &&
            l1Integrity.global_pass &&
            l1?.accepted_by_global_runner === true &&
            l1?.execution === 'EXECUTED'
          ? 'PASS'
          : l1?.status === 'FAIL'
            ? 'FAIL'
            : l1?.status === 'PARTIAL' || l1?.status === 'NOT_ADJUDICATED'
              ? 'PARTIAL'
              : 'BLOCKED_DEPENDENCY';
  const needs = dependenciesByScenario[scenario.id] ?? [
    'scenario-specific provider seed and verified identity',
  ];
  const blockers =
    l1State === 'PASS'
      ? []
      : !l1ReportAvailable
        ? [
            'L1 runner not executed; run node scripts/run-h5-int01-l1.mjs',
            ...needs,
          ]
        : !l1Integrity.valid && l1Integrity.errors.length > 0
          ? l1Integrity.errors.map((error) => `L1_EVIDENCE_INVALID:${error}`)
          : l1State === 'PARTIAL' &&
              scenario.id === 'INT01-VARIANTE-DESACTIVADA'
            ? [
                'Catalog registra estado INACTIVA, pero falta probar su exclusión por el oráculo comercial real',
              ]
            : l1State === 'PARTIAL' &&
                scenario.id === 'INT01-IDENTIDAD-SCOPE-DENEGADO'
              ? [
                  'El rechazo de scope se verificó solo en Catalog; falta ejecutar la autorización en Pricing e Inventory reales',
                ]
              : !l1Report
                ? [
                    'L1 runner not executed; run node scripts/run-h5-int01-l1.mjs',
                    ...needs,
                  ]
                : (l1?.blockers ?? needs);
  return {
    scenario_id: scenario.id,
    implementation_status: 'IMPLEMENTED_L0_CONTRACT',
    l0: {
      state: l0Evidence.status,
      execution: l0Evidence.execution,
      passed: l0Evidence.status === 'PASS',
      evidence_level: 'L0',
      artifact: l0Evidence.path,
      sha256: l0Evidence.sha256,
      command: 'node scripts/run-h5-vitest.mjs int01',
    },
    l1: {
      state: l1State,
      ...evidenceByLevel({
        l0State: l0Evidence.status,
        l0Executed: l0Evidence.execution === 'EXECUTED',
        l1State,
        l1Execution: l1?.execution,
        l1EvidenceValid:
          l1Integrity.global_pass && l1?.accepted_by_global_runner === true,
      }).l1,
      evidence_level: l1?.evidence_level ?? 'L1',
      scenario_providers_required: scenario.required_providers,
      owner: ownersByScenario[scenario.id] ?? ['Poma/Catalog'],
      dependencies: needs,
      blockers,
      providers_started: l1?.providers_started ?? [],
      providers_queried: l1?.providers_queried ?? [],
      providers_participating: l1?.providers_participating ?? [],
      simulated_providers: l1?.simulated_providers ?? [],
      partial_provider_subcases: authSubcase
        ? [
            {
              scenario_id: authSubcase.scenario_id,
              status: authSubcase.status,
              providers_participating: authSubcase.providers_participating,
              evidence_level: authSubcase.evidence_level,
            },
          ]
        : [],
      identity_authorization: l1?.identity_authorization ?? 'NOT_RUN',
      evidence: l1Report ? 'test-results/h5/int01-l1-summary.json' : null,
      rerun_command: 'node scripts/run-h5-int01-l1.mjs',
    },
    endpoints: (scenarioOperationMap[scenario.id] ?? [])
      .map((id) => capabilities.find((item) => item.operation_id === id))
      .filter(Boolean),
  };
});
const npmResult = spawnSync(
  process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : 'npm',
  process.platform === 'win32'
    ? ['/d', '/s', '/c', 'npm --version']
    : ['--version'],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true },
);
const report = {
  schema_version: 1,
  case_id: 'INT-01',
  task_id: 'POM-A01',
  h5_criterion: 'H5-02',
  repository: 'Taller-SW-Web/G6-Productos-Ofertas-backend',
  owner: 'Poma',
  source_sha: sourceSha,
  docs_sha: docsSha,
  master_sha: masterSha,
  master_ref_source:
    'local origin/master object; remote freshness must be confirmed by GitHub before publication',
  timestamp_utc: new Date().toISOString(),
  config_version: 'h5-int01-master-capability-preflight-v1',
  tool_versions: {
    node: process.version,
    npm: npmResult.status === 0 ? npmResult.stdout.trim() : 'UNAVAILABLE',
  },
  command: 'node scripts/run-h5-int01-preflight.mjs',
  worktree_dirty: worktreeDirty,
  contract: {
    version: '0.7.0-rc.3',
    docs_sha: docsSha,
    endpoints: capabilities,
  },
  l1_capability_requirements: {
    fullTripartite: [
      'three services + Gateway at one verified Backend SHA',
      'independent disposable databases or owner-authorized service stores',
      'Catalog/Pricing/Inventory seeders',
      'authorized synthetic identity per service',
      'correlated request/operation trace proving started, queried and participated',
    ],
    localCatalogSubcases: [
      'Docker daemon',
      'PostgreSQL 17 TLS disposable container',
      'real Catalog Nest application and local Gateway',
      'Taxonomy is an explicit loopback fixture only',
    ],
  },
  counts: {
    scenarios: scenarioCases.length,
    implemented: scenarioCases.filter((item) =>
      item.implementation_status.startsWith('IMPLEMENTED'),
    ).length,
    l0_passed: scenarioCases.filter((item) => item.l0.state === 'PASS').length,
    l0_executed: scenarioCases.filter(
      (item) => item.l0.execution === 'EXECUTED',
    ).length,
    l1_executed: scenarioCases.filter((item) => item.l1.executed).length,
    l1_passed: scenarioCases.filter((item) => item.l1.state === 'PASS').length,
    l1_partial: scenarioCases.filter((item) => item.l1.state === 'PARTIAL')
      .length,
    l1_failed: scenarioCases.filter((item) => item.l1.state === 'FAIL').length,
    l1_blocked: scenarioCases.filter(
      (item) => item.l1.state === 'BLOCKED_DEPENDENCY',
    ).length,
  },
  scenarios: scenarioCases,
  limitations: [
    'L0 validates synthetic oracles only.',
    'An L1 partial subcase does not satisfy the full multi-provider scenario.',
    'No shared services, Azure, APIM, G7, Supabase or shared Service Bus are contacted.',
  ],
};
const serialized = `${JSON.stringify(report, null, 2)}\n`;
assertSafeEvidenceText(serialized);
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, serialized, 'utf8');
const digest = createHash('sha256')
  .update(Buffer.from(serialized, 'utf8'))
  .digest('hex');
const index = {
  schema_version: 1,
  artifact: outputPath.replaceAll('\\', '/'),
  sha256: digest,
  case_id: report.case_id,
  task_id: report.task_id,
  h5_criterion: report.h5_criterion,
  source_sha: sourceSha,
  master_sha: masterSha,
  docs_sha: docsSha,
  status: int01L1IndexStatus(scenarioCases),
  l1_report_integrity: { ...l1Integrity, report_present: l1ReportAvailable },
};
const indexText = `${JSON.stringify(index, null, 2)}\n`;
assertSafeEvidenceText(indexText);
await writeFile(indexPath, indexText, 'utf8');
process.stdout.write(
  `INT01 preflight: scenarios=${report.counts.scenarios}; L0=${report.counts.l0_passed}; L1_pass=${report.counts.l1_passed}; L1_partial=${report.counts.l1_partial}; L1_blocked=${report.counts.l1_blocked}; master=${masterSha ?? 'UNAVAILABLE'}; evidence_sha256=${digest}.\n`,
);
