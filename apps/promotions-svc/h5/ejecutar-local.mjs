import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const h5 = resolve(root, 'apps/promotions-svc/h5');
const scenarios = JSON.parse(await readFile(resolve(h5, 'escenarios.json'), 'utf8'));
function resolveNpmCli() {
  const candidates = [
    resolve(root, 'node_modules/npm/bin/npm-cli.js'),
    resolve(dirname(process.execPath), '../node_modules/npm/bin/npm-cli.js'),
  ];
  if (process.platform === 'win32') {
    try {
      const npmCmd = execFileSync('where.exe', ['npm.cmd'], { encoding: 'utf8' }).split(/\r?\n/)[0].trim();
      candidates.push(resolve(dirname(npmCmd), 'node_modules/npm/bin/npm-cli.js'));
    } catch { /* use an explicit npm_cli_path error below */ }
  }
  const found = candidates.find((candidate) => {
    try { execFileSync(process.execPath, ['-e', "require('node:fs').accessSync(process.argv[1])", candidate], { stdio: 'ignore' }); return true; }
    catch { return false; }
  });
  if (!found) throw new Error('NPM_CLI_NOT_FOUND');
  return found;
}
const npmCli = resolveNpmCli();
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
  'apps/promotions-svc/h5/ejecutar-integracion.test.mjs',
  'apps/promotions-svc/h5/autorizacion-mutaciones.mjs',
  'apps/promotions-svc/h5/autorizacion-mutaciones.test.mjs',
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
    bin: process.execPath,
    args: ['--test',
      'apps/promotions-svc/h5/autorizacion-mutaciones.test.mjs',
      'apps/promotions-svc/h5/ejecutar-integracion.test.mjs',
      'apps/promotions-svc/h5/preparar-planes.test.mjs',
      'apps/promotions-svc/h5/ejecutar-controlado.test.mjs',
      'apps/promotions-svc/h5/ejecutar-matriz.test.mjs',
      'apps/promotions-svc/h5/verificar-despliegue.test.mjs',
      'apps/promotions-svc/h5/evidencia-integracion.test.mjs'],
  },
  {
    id: 'coupon-unit',
    ...npm(['test', '--', 'apps/promotions-svc/src/coupons/coupon-h5-operations.spec.ts',
      'apps/promotions-svc/src/coupons/service-bus-events.spec.ts', '--reporter=verbose', '--maxWorkers=1']),
  },
  {
    id: 'promotions-http',
    ...npm(['run', 'test:e2e', '--', 'apps/promotions-svc/test/coupon-h5-boundary.e2e-spec.ts', '--reporter=verbose', '--maxWorkers=1']),
  },
  {
    id: 'inventory-reservations',
    ...npm(['run', 'test:e2e', '--', 'apps/inventory-svc/test/app.e2e-spec.ts', '--reporter=verbose', '--maxWorkers=1']),
  },
  {
    id: 'postgres-h5',
    bin: process.execPath,
    args: ['apps/promotions-svc/test/run-h5-postgres.mjs'],
  },
];
const coverage = {
  'G5-H5-01': [{ command: 'inventory-reservations', title: 'Ciclo completo: solicitar reserva -> consultar operacion -> confirmar consumo', scope: 'reserva y consulta durable local' }],
  'G5-H5-02': [],
  'G5-H5-03': [{ command: 'inventory-reservations', title: 'Ciclo completo: solicitar reserva -> consultar operacion -> confirmar consumo', scope: 'confirmación de reserva local; pago y firma G5 no cubiertos' }],
  'G5-H5-04': [{ command: 'inventory-reservations', title: 'Ciclo de liberación: solicitar reserva -> liberar por pago no completado', scope: 'liberación Inventory; cancelación/constancia G5 no cubiertas' }],
  'G5-H5-05': [{ command: 'postgres-h5', title: 'processes the G5 snapshot adapter through durable G6 coupon eligibility and Inventory evidence', scope: 'snapshot doble y efecto local PostgreSQL; sin Gateway/G5 real' }],
  'G5-H5-06': [{ command: 'postgres-h5', title: 'restores only the consumption operation linked to the same order', scope: 'vínculo de restauración local; anulación firmada G5 no cubierta' }],
  'G5-H5-07': [],
  'G5-H5-08': [{ command: 'postgres-h5', title: 'replays identical admissions and rejects changed content with one durable intent', scope: 'idempotencia durable local; POST Gateway/replay no cubierto' }],
  'G5-H5-09': [], 'G5-H5-10': [], 'G5-H5-11': [], 'G5-H5-12': [],
  'G5-H5-13': [{ command: 'promotions-http', title: 'serves snapshots by order and returns one indistinguishable 404 for missing or other orders', scope: '404 uniforme local Promotions; autorización externa/Gateway no cubiertos' }],
  'G5-H5-14': [
    { command: 'inventory-reservations', title: 'Ciclo completo: solicitar reserva -> consultar operacion -> confirmar consumo', scope: 'JWT de prueba válido en servicio Inventory local' },
    { command: 'inventory-reservations', title: 'debe rechazar con 401 TOKEN_INVALIDO si falta el encabezado Authorization', scope: '401 local' },
    { command: 'inventory-reservations', title: 'debe rechazar con 401 TOKEN_INVALIDO si el token está expirado', scope: 'JWT expirado local' },
    { command: 'inventory-reservations', title: 'debe rechazar con 403 SCOPE_INSUFICIENTE si el token carece del scope necesario', scope: '403 local' },
  ],
  'G5-H5-15': [{ command: 'postgres-h5', title: 'recovers ambiguous delivery after restart and commits a single effect before settlement', scope: 'worker/Outbox local; Gateway aislado no cubierto' }],
  'G5-H5-16': [{ command: 'postgres-h5', title: 'recovers ambiguous delivery after restart and commits a single effect before settlement', scope: 'efecto único local; redelivery Service Bus real no cubierta' }],
  'G5-H5-17': [{ command: 'inventory-reservations', title: 'un retry idéntico no duplica stock ni Kardex', scope: 'reintegro idempotente local; recepción parcial M2 no cubierta' }],
  'G5-H5-18': [], 'G5-H5-19': [], 'G5-H5-20': [],
};
const missingCoverage = {
  'G5-H5-01': 'Gateway privado, token G7 autorizado y pedido/snapshot G5 asociado.',
  'G5-H5-02': 'Caso local de saldo insuficiente y verificación G5/M1 de que no cobra ni consume.',
  'G5-H5-03': 'Pago G5 firmado y confirmación cruzada usando despliegues G5/G6 reales.',
  'G5-H5-04': 'Anulación G5 firmada y recorrido Gateway autenticado; el test local negativo de restauración no forma parte de este caso.',
  'G5-H5-05': 'Gateway, snapshot G5 real, consulta durable del caso y evidencia de Azure Service Bus.',
  'G5-H5-06': 'Constancia real de anulación G5 y liberación Inventory en la misma ejecución aislada.',
  'G5-H5-07': 'Pérdida de respuesta HTTP real, reinvocación/follow del mismo UUID y lectura durable.',
  'G5-H5-08': 'Replays y conflicto 409 mediante el Gateway privado del pedido autorizado.',
  'G5-H5-09': 'Reinicio coordinado de M1 en G5 y posterior GET durable correlacionado.',
  'G5-H5-10': 'Fixture de reserva vencida y consulta antes del barrido real de expiración.',
  'G5-H5-11': 'Barrido M1 real entre consultas y conciliación bilateral de EXPIRADA.',
  'G5-H5-12': 'Carrera sincronizada pago/anulación/vencimiento con G5 y reserva G6.',
  'G5-H5-13': 'Operación real del pedido original y comparación autenticada de 404 en Gateway.',
  'G5-H5-14': 'JWTs reales G7 y validación en Gateway privado; local usa claves de test de Inventory.',
  'G5-H5-15': 'Worker de la revisión aislada desplegada, lectura autorizada de Outbox y constancia supervisada.',
  'G5-H5-16': 'Redelivery/settlement de Azure Service Bus real y verificación Inbox/efecto por MessageId.',
  'G5-H5-17': 'Recepción parcial autorizada de M2 y reintegro ligado al pedido G5.',
  'G5-H5-18': 'Aprobación G5 del cambio, fixture G2 y evidencia de reserva/consumo antes del despacho.',
  'G5-H5-19': 'Ventana de corte, pausado/conciliación/reversión en entorno G5/G6 aislado.',
  'G5-H5-20': 'Topología desplegada, handlers por destinatario y lecturas autorizadas de Inbox/Outbox por MessageId.',
};

function assertionResults(commands) {
  const byCommand = new Map(commands.map((command) => [command.id, command]));
  return Object.fromEntries(Object.entries(coverage).map(([id, assertions]) => [id,
    assertions.map((assertion) => {
      const command = byCommand.get(assertion.command);
      const lines = String(command?.stdout ?? '').split(/\r?\n/).filter((line) => line.includes(assertion.title));
      const passed = command?.status === 'PASS' && lines.some((line) => line.includes('✓') || line.includes('✔'));
      const failed = lines.some((line) => line.includes('×') || line.includes('✖'));
      return { ...assertion, result: failed ? 'FAIL' : passed ? 'PASS' : 'NOT_RUN' };
    }),
  ]));
}

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
    stdout: String(result.stdout ?? ''),
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
  const assertionCoverage = assertionResults(commands);
  const results = scenarios.map((scenario) => {
    const localAssertions = assertionCoverage[scenario.id] ?? [];
    const passed = localAssertions.filter((assertion) => assertion.result === 'PASS');
    const failed = localAssertions.some((assertion) => assertion.result === 'FAIL');
    return {
      id: scenario.id,
      local_test_status: failed ? 'FAIL' : passed.length ? 'PARTIAL' : 'NOT_RUN',
      local_assertions: localAssertions,
      local_missing: missingCoverage[scenario.id],
      technical_status: 'NOT_RUN',
      status: 'BLOCKED',
      reason: failed ? 'LOCAL_ASSERTION_FAILED' : passed.length ? 'PARTIAL_G6_LOCAL_ONLY_NOT_HOMOLOGATION' : 'NO_MATCHING_LOCAL_ASSERTION_EXECUTED',
    };
  });
  const report = {
    report_type: 'G6_LOCAL_G5_H5',
    recorded_at: new Date().toISOString(),
    evidence_id: randomUUID(),
    tested_git_head: testedHead,
    tested_git_commit: testedHead,
    tested_tree_sha256: tree.digest('hex'),
    node_version: process.version,
    node_executable: process.execPath,
    tested_files: fileHashes,
    commands: commands.map(({ stdout: _stdout, ...command }) => command),
    results,
    conclusions: {
      homologation: 'NONE',
      real_g5_requests: 0,
      real_g7_tokens: 0,
      shared_azure_changes: 0,
      note: 'Assertions match exact test titles in verbose output. Local checks are partial G6 regression evidence only and never G5 homologation.',
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
