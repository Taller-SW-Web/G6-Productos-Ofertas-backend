import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const h5 = resolve(root, 'apps/promotions-svc/h5');
const scenarios = JSON.parse(await readFile(resolve(h5, 'escenarios.json'), 'utf8'));
const npmCli = resolve(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
const npm = (args) => process.platform === 'win32'
  ? { bin: process.execPath, args: [npmCli, ...args] }
  : { bin: 'npm', args };
const files = [
  'apps/promotions-svc/h5/escenarios.json',
  'apps/promotions-svc/h5/ESCENARIOS_G5_H5.md',
  'apps/promotions-svc/h5/PRUEBA_CONJUNTA_G5.md',
  'apps/promotions-svc/h5/perfil-autorizado.schema.json',
  'apps/promotions-svc/h5/preparar-planes.mjs',
  'apps/promotions-svc/h5/preparar-planes.test.mjs',
  'apps/promotions-svc/h5/ejecutar-controlado.mjs',
  'apps/promotions-svc/h5/ejecutar-controlado.test.mjs',
  'apps/promotions-svc/h5/ejecutar-local.mjs',
  'apps/promotions-svc/h5/ejecutar-integracion.mjs',
  'apps/promotions-svc/h5/ejecutar-matriz.mjs',
  'apps/promotions-svc/h5/ejecutar-matriz.test.mjs',
  'apps/promotions-svc/h5/verificar-despliegue.mjs',
  'apps/promotions-svc/h5/verificar-despliegue.test.mjs',
  'apps/promotions-svc/h5/evidencia-integracion.mjs',
  'apps/promotions-svc/h5/evidencia-integracion.test.mjs',
  'apps/promotions-svc/test/coupon-h5-boundary.e2e-spec.ts',
  'apps/promotions-svc/test/coupon-h5.postgres.e2e-spec.ts',
  'apps/promotions-svc/test/run-h5-postgres.mjs',
  'apps/inventory-svc/test/app.e2e-spec.ts',
];
const commandSpecs = [
  {
    id: 'h5-runners',
    bin: 'node',
    args: ['--test',
      'apps/promotions-svc/h5/preparar-planes.test.mjs',
      'apps/promotions-svc/h5/ejecutar-controlado.test.mjs',
      'apps/promotions-svc/h5/ejecutar-matriz.test.mjs',
      'apps/promotions-svc/h5/verificar-despliegue.test.mjs',
      'apps/promotions-svc/h5/evidencia-integracion.test.mjs'],
  },
  {
    id: 'coupon-unit',
    ...npm(['test', '--', 'apps/promotions-svc/src/coupons/coupon-h5-operations.spec.ts',
      'apps/promotions-svc/src/coupons/service-bus-events.spec.ts', '--maxWorkers=1']),
  },
  {
    id: 'promotions-http',
    ...npm(['run', 'test:e2e', '--', 'apps/promotions-svc/test/coupon-h5-boundary.e2e-spec.ts', '--maxWorkers=1']),
  },
  {
    id: 'inventory-reservations',
    ...npm(['run', 'test:e2e', '--', 'apps/inventory-svc/test/app.e2e-spec.ts', '--maxWorkers=1']),
  },
  {
    id: 'postgres-h5',
    bin: 'node',
    args: ['apps/promotions-svc/test/run-h5-postgres.mjs'],
  },
];
const coverage = {
  'G5-H5-01': ['inventory-reservations'], 'G5-H5-02': ['inventory-reservations'],
  'G5-H5-03': ['postgres-h5'], 'G5-H5-04': ['postgres-h5', 'inventory-reservations'],
  'G5-H5-05': ['postgres-h5'], 'G5-H5-06': ['postgres-h5'], 'G5-H5-07': ['postgres-h5'],
  'G5-H5-08': ['postgres-h5'], 'G5-H5-13': ['promotions-http'], 'G5-H5-14': ['promotions-http'],
  'G5-H5-15': ['postgres-h5'], 'G5-H5-16': ['postgres-h5'],
};

function run(spec) {
  const started = Date.now();
  const result = spawnSync(spec.bin, spec.args, {
    cwd: root,
    encoding: 'utf8',
    shell: false,
    timeout: spec.id === 'postgres-h5' ? 300_000 : 180_000,
    env: process.env,
  });
  return {
    id: spec.id,
    command: [spec.bin, ...spec.args],
    status: result.error ? 'FAIL' : result.status === 0 ? 'PASS' : 'FAIL',
    exit_code: result.status ?? null,
    error_code: result.error?.code,
    duration_ms: Date.now() - started,
    stdout_tail: String(result.stdout ?? '').slice(-3000),
    stderr_tail: String(result.stderr ?? '').slice(-2000),
  };
}

export async function ejecutarLocal(outputPath) {
  const testedHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const fileHashes = [];
  const tree = createHash('sha256');
  for (const path of files) {
    const data = await readFile(resolve(root, path));
    const hash = createHash('sha256').update(data).digest('hex');
    fileHashes.push({ path, sha256: hash });
    tree.update(path).update('\0').update(data).update('\0');
  }
  const commands = [];
  for (const spec of commandSpecs) {
    const result = run(spec);
    commands.push(result);
  }
  const commandStatuses = new Map(commands.map((result) => [result.id, result.status]));
  const results = scenarios.map((scenario) => {
    const localChecks = coverage[scenario.id] ?? [];
    const complete = localChecks.length > 0 && localChecks.every((id) => commandStatuses.get(id) === 'PASS');
    const failed = localChecks.some((id) => commandStatuses.get(id) === 'FAIL');
    return {
      id: scenario.id,
      local_test_status: failed ? 'FAIL' : complete ? 'PASS' : 'NOT_RUN',
      local_scope: localChecks,
      technical_status: 'NOT_RUN',
      status: 'BLOCKED',
      reason: complete
        ? 'G6_LOCAL_ONLY_NOT_HOMOLOGATION'
        : failed
          ? 'LOCAL_G6_TEST_FAILED'
          : 'G6_LOCAL_COVERAGE_NOT_EXECUTED_OR_NOT_AVAILABLE',
    };
  });
  const report = {
    report_type: 'G6_LOCAL_G5_H5',
    recorded_at: new Date().toISOString(),
    evidence_id: randomUUID(),
    tested_git_head: testedHead,
    tested_tree_sha256: tree.digest('hex'),
    tested_files: fileHashes,
    commands,
    results,
    conclusions: {
      homologation: 'NONE',
      real_g5_requests: 0,
      real_g7_tokens: 0,
      shared_azure_changes: 0,
      note: 'Local PostgreSQL and explicit G5/Service Bus test doubles are G6 regression evidence only.',
    },
  };
  await writeFile(resolve(outputPath), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  return report;
}

async function main() {
  const [outputPath] = process.argv.slice(2);
  if (!outputPath) throw new Error('USO: ejecutar-local.mjs evidence-new.json');
  const report = await ejecutarLocal(outputPath);
  const fail = report.commands.some((command) => command.status === 'FAIL');
  console.log(JSON.stringify({ output: resolve(outputPath), tested_git_head: report.tested_git_head, tree_sha256: report.tested_tree_sha256, passed_commands: report.commands.filter((command) => command.status === 'PASS').length, failed_commands: report.commands.filter((command) => command.status === 'FAIL').length, scenarios: report.results.length }));
  process.exitCode = fail ? 1 : 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    const message = /^[A-Z0-9_-]{1,100}$/.test(error?.message ?? '') ? error.message : 'LOCAL_RUN_FAILED';
    console.error(JSON.stringify({ status: 'FAIL', error: message }));
    process.exitCode = 1;
  });
