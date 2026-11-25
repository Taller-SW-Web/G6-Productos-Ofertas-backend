import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const docsSha = 'c9e1e5c217616d28229fccf5315fb97a1ae061a9';
const contractSha =
  'f3331a6630b68039a1d33063000c600ec74db7429d78846da922141101e6c0eb';
const migrationSha =
  '8c71c5b24c70aedacb59801a3403423a933dae83fdc3aaacc8970fe840c21072';
const docs = resolve(
  process.env.G6_E2E_DOCS_PATH ?? '../G6-Productos-Ofertas-docs',
);
const mode = process.argv[2] ?? 'all';
const valid = ['all', 'read', 'deactivate', 'contract', 'barrier', 'azure'];
if (!valid.includes(mode)) {
  console.error(
    'USAGE: node tests/h5/run-int06.mjs [all|read|deactivate|contract|barrier|azure]',
  );
  process.exit(2);
}
const hashFile = (path) =>
  createHash('sha256').update(readFileSync(path)).digest('hex');
let docsValid = false;
try {
  docsValid =
    hashFile(resolve(docs, 'contratos/eventos/asyncapi.yaml')) ===
      contractSha &&
    hashFile(
      resolve(docs, 'datos/taxonomy/migrations/0001_create_taxonomy.sql'),
    ) === migrationSha;
} catch {
  /* prerequisite not available */
}
const sha = spawnSync('git', ['rev-parse', 'HEAD'], {
  encoding: 'utf8',
}).stdout.trim();
const status = spawnSync('git', ['status', '--porcelain'], {
  encoding: 'utf8',
}).stdout;
const testFiles = [
  'tests/h5/int06-cases.json',
  'tests/h5/int06-asyncapi.mjs',
  'tests/h5/int06-contract.e2e-spec.ts',
  'tests/h5/int06-harness.e2e-spec.ts',
  'tests/h5/taxonomy-service-bus.postgres.e2e-spec.ts',
  'tests/h5/run-int06.mjs',
  'tests/h5/int06-http-runner.mjs',
  'apps/taxonomy-svc/test/persistencia-drizzle.e2e-spec.ts',
  'scripts/ci/run-taxonomy-integration.mjs',
];
const fingerprint = createHash('sha256');
for (const f of testFiles.sort())
  fingerprint.update(f + '\0').update(readFileSync(f));
const result = [];
function run(id, command, args, needsDocs) {
  if (needsDocs && !docsValid)
    return {
      case_id: id,
      implementation_state: 'READY_FOR_INTEGRATION',
      execution_result: 'BLOCKED_CONTRACT',
      reason: 'DOCS_BASELINE_HASH_MISMATCH',
      owner: 'Docs',
    };
  const p = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    timeout: 240000,
    maxBuffer: 12 * 1024 * 1024,
    env: { ...process.env, G6_E2E_DOCS_PATH: docs },
    windowsHide: true,
  });
  const output = (p.stdout ?? '') + '\n' + (p.stderr ?? '');
  const counts =
    output.match(/(?:Tests\s+|PASS: )(\d+)\s*(?:passed|\/\d+ pruebas)/i)?.[1] ??
    null;
  const phase = output.match(
    /\[taxonomy-integration\] FAIL fase=([a-z0-9-]+)/i,
  )?.[1];
  const minimum = id === 'TAX-DB-BARRIER' ? 7 : 5;
  const incomplete =
    !counts ||
    Number(counts) < minimum ||
    /Tests\s+[^\r\n]*\bskipped\b/i.test(output);
  return {
    case_id: id,
    implementation_state: 'DONE_LOCAL',
    execution_result: p.error
      ? 'INCONCLUSIVE'
      : p.status !== 0
        ? 'FAIL'
        : incomplete
          ? 'INCONCLUSIVE'
          : 'PASS',
    reason: phase
      ? `HARNESS_PHASE_${phase}`
      : incomplete
        ? 'MISSING_OR_INCOMPLETE_TEST_RESULTS'
        : null,
    exit_code: p.status,
    tool_error: p.error?.code ?? null,
    tests_passed: counts,
    test_command: command,
    level: 'L1_ISOLATED',
  };
}
const httpTests = {
  'TAX-HTTP-READ-TREE': [
    'consulta categorías y marcas con JWT verificado y PostgreSQL aislado',
    'GET /api/v1/categorias/arbol => 200',
  ],
  'TAX-HTTP-READ-CATEGORY': [
    'consulta categorías y marcas con JWT verificado y PostgreSQL aislado',
    'GET /api/v1/categorias/:id => 200',
  ],
  'TAX-HTTP-READ-BRAND': [
    'consulta categorías y marcas con JWT verificado y PostgreSQL aislado',
    'GET /api/v1/marcas/:id => 200',
  ],
  'TAX-HTTP-READ-SEO': [
    'consulta categorías y marcas con JWT verificado y PostgreSQL aislado',
    'GET /api/v1/categorias/:id/seo => 200',
  ],
  'TAX-HTTP-READ-PRODUCT_TYPE': [
    'consulta categorías y marcas con JWT verificado y PostgreSQL aislado',
    'GET /api/v1/tipos-producto => 200',
  ],
  'TAX-HTTP-READ-401': [
    'consulta categorías y marcas con JWT verificado y PostgreSQL aislado',
    'JWT ausente => 401',
  ],
  'TAX-HTTP-READ-403': [
    'consulta categorías y marcas con JWT verificado y PostgreSQL aislado',
    'rol ajeno => 403',
  ],
  'TAX-HTTP-DEACTIVATE-202': [
    'admite las cinco clases de baja segura HTTP y deduplica por correlación',
    'POST baja => 202',
  ],
  'TAX-HTTP-DEACTIVATE-PENDING': [
    'consulta operaciones de baja desde HTTP sobre el esquema local migrado',
    'GET operación => PENDING_DEACTIVATION',
  ],
  'TAX-HTTP-DEACTIVATE-OPERATION_POLL': [
    'consulta operaciones de baja desde HTTP sobre el esquema local migrado',
    'GET operación => 200 con entity_id y operation_id',
  ],
  'TAX-HTTP-DEACTIVATE-COMPLETED': [
    'consulta operaciones de baja desde HTTP sobre el esquema local migrado',
    'GET operación => COMPLETED / CLEAR tras cambio de fixture SQL',
  ],
  'TAX-HTTP-DEACTIVATE-REJECTED': [
    'consulta operaciones de baja desde HTTP sobre el esquema local migrado',
    'GET operación => REJECTED / IN_USE tras cambio de fixture SQL',
  ],
};
if (mode === 'all' || mode === 'read' || mode === 'deactivate') {
  const p = spawnSync(process.execPath, ['tests/h5/int06-http-runner.mjs'], {
    encoding: 'utf8',
    timeout: 300000,
    maxBuffer: 12 * 1024 * 1024,
    windowsHide: true,
  });
  let report;
  try {
    report = JSON.parse(p.stdout);
  } catch {
    report = null;
  }
  for (const [case_id, [test_name, assertion]] of Object.entries(httpTests)) {
    if (mode === 'read' && !case_id.startsWith('TAX-HTTP-READ-')) continue;
    if (mode === 'deactivate' && !case_id.startsWith('TAX-HTTP-DEACTIVATE-'))
      continue;
    const matches = (report?.assertions ?? []).filter(
      (t) => t.title === test_name,
    );
    const passed = matches.length === 1 && matches[0].status === 'passed';
    result.push({
      case_id,
      implementation_state: 'DONE_LOCAL',
      execution_result: p.error
        ? 'INCONCLUSIVE'
        : p.status !== 0
          ? 'FAIL'
          : passed
            ? 'PASS'
            : 'INCONCLUSIVE',
      reason: passed ? null : 'SPECIFIC_TEST_NOT_VERIFIED',
      test_file: 'apps/taxonomy-svc/test/persistencia-drizzle.e2e-spec.ts',
      test_name,
      assertion,
      expected_test_count: 1,
      tests_passed: matches.filter((t) => t.status === 'passed').length,
      test_command: 'node tests/h5/int06-http-runner.mjs',
      level: 'L1_ISOLATED',
    });
  }
}
if (mode === 'all' || mode === 'contract')
  result.push(
    run(
      'TAX-CONTRACT-R09-R18',
      'node tests/h5/run-int06.mjs contract',
      [
        'node_modules/vitest/vitest.mjs',
        'run',
        '--config',
        'vitest.config.e2e.ts',
        'tests/h5/int06-contract.e2e-spec.ts',
        'tests/h5/int06-harness.e2e-spec.ts',
      ],
      true,
    ),
  );
if (mode === 'all' || mode === 'barrier')
  result.push(
    run(
      'TAX-DB-BARRIER',
      'node tests/h5/run-int06.mjs barrier',
      ['tests/h5/run-taxonomy-catalog-postgres.mjs', docs],
      true,
    ),
  );
if (mode === 'all' || mode === 'azure')
  result.push({
    case_id: 'TAX-AZURE-R18',
    implementation_state: 'BLOCKED_DEPENDENCY',
    execution_result: 'BLOCKED_SB',
    level: 'L2_PENDING',
    owner: 'Axel / Azure',
    reason: 'AUTHORIZED_DEPLOYMENT_RBAC_AND_TEST_DATA_REQUIRED',
    test_command: 'node tests/h5/run-int06.mjs azure',
  });
const evidence = {
  repo: 'G6-Productos-Ofertas-backend',
  source_sha: sha,
  source_tree_dirty: Boolean(status.trim()),
  source_fingerprint_sha256: fingerprint.digest('hex'),
  docs_sha: docsSha,
  asyncapi_sha256: contractSha,
  docs_verified: docsValid,
  timestamp_utc: new Date().toISOString(),
  node_version: process.version,
  environment: 'LOCAL_DISPOSABLE_POSTGRES',
  config_version: 'ASYNCAPI_0.7.0-rc.3',
  dataset_seed: 'synthetic-random-uuid-per-test',
  cases: result,
};
const evidenceText = JSON.stringify(evidence, null, 2) + '\n';
const evidenceHash = createHash('sha256').update(evidenceText).digest('hex');
const outfile = process.env.G6_INT06_EVIDENCE_PATH;
if (outfile) writeFileSync(outfile, evidenceText);
const definitions = JSON.parse(
  readFileSync('tests/h5/int06-cases.json', 'utf8'),
).cases;
const cases = definitions.map((definition) => {
  const suite =
    result.find((item) => item.case_id === definition.case_id) ??
    result.find((item) => item.case_id === definition.suite);
  const execution_result =
    suite?.execution_result ?? definition.execution_result;
  return {
    ...definition,
    execution_result,
    reason: suite?.reason ?? null,
    ...(httpTests[definition.case_id]
      ? {
          test_file:
            suite?.test_file ??
            'apps/taxonomy-svc/test/persistencia-drizzle.e2e-spec.ts',
          test_name: httpTests[definition.case_id][0],
          assertion: httpTests[definition.case_id][1],
          expected_test_count: 1,
          tests_passed: suite?.tests_passed ?? 0,
        }
      : {}),
    h5_criterion: 'H5-02',
    repo: evidence.repo,
    source_sha: sha,
    docs_sha: docsSha,
    environment:
      definition.suite === 'TAX-AZURE-R18'
        ? 'L2_PENDING'
        : evidence.environment,
    timestamp_utc: evidence.timestamp_utc,
    config_version: evidence.config_version,
    dataset_seed: evidence.dataset_seed,
    tool_versions: { node: process.version },
    artifact_uri: outfile ? 'int06-evidence.json' : null,
    sha256_artifact: outfile ? evidenceHash : null,
    level: definition.suite === 'TAX-AZURE-R18' ? 'L2_PENDING' : 'L1_ISOLATED',
    expected: definition.suite === 'TAX-AZURE-R18' ? 'BLOCKED_SB' : 'PASS',
    observed: execution_result,
    negative_tests: [
      '401',
      '403',
      'IN_USE',
      'stale',
      'duplicate',
      'invalid_uuid',
    ].filter((x) => definition.case_id.toLowerCase().includes(x.toLowerCase())),
    known_limits:
      definition.suite === 'TAX-AZURE-R18'
        ? 'No Azure access or deployment verified'
        : 'Synthetic JWT and disposable DB; no real G7 or Azure',
    blocker_owner: execution_result.startsWith('BLOCKED_')
      ? definition.owner
      : null,
  };
});
const coverage = {
  total_cases: cases.length,
  implemented_cases: cases.filter(
    (c) => c.implementation_state === 'DONE_LOCAL',
  ).length,
  executed_local_cases: cases.filter((c) =>
    ['PASS', 'FAIL', 'INCONCLUSIVE'].includes(c.execution_result),
  ).length,
  passed_local_cases: cases.filter((c) => c.execution_result === 'PASS').length,
  blocked_external_cases: cases.filter((c) =>
    c.execution_result.startsWith('BLOCKED_'),
  ).length,
  failed_cases: cases.filter((c) => c.execution_result === 'FAIL').length,
  unimplemented_cases: cases.filter(
    (c) => c.implementation_state === 'BLOCKED_DEPENDENCY',
  ).length,
  evidence_sha256: outfile ? evidenceHash : null,
  cases,
};
if (process.env.G6_INT06_MANIFEST_PATH)
  writeFileSync(
    process.env.G6_INT06_MANIFEST_PATH,
    JSON.stringify(coverage, null, 2) + '\n',
  );
console.log(JSON.stringify(evidence, null, 2));
if (result.some((x) => ['FAIL', 'INCONCLUSIVE'].includes(x.execution_result)))
  process.exitCode = 1;
else if (
  result.some((x) => x.execution_result === 'BLOCKED_CONTRACT') ||
  mode === 'azure'
)
  process.exitCode = 2;
