import { readFile } from 'node:fs/promises';

const [reportPath, scenariosPath, matrixPath] = process.argv.slice(2);
if (!reportPath || !scenariosPath || !matrixPath) {
  throw new Error(
    'Uso: verify-bulk-h5-e2e.mjs <vitest-json> <scenarios-json> <matrix-json>',
  );
}

const [report, scenarioEvidence, matrix] = await Promise.all(
  [reportPath, scenariosPath, matrixPath].map(async (path) =>
    JSON.parse(await readFile(path, 'utf8')),
  ),
);
const errors = [];
const files = report.testResults ?? [];
const tests = files.flatMap((file) => file.assertionResults ?? []);
const testFiles = files.map((file) => file.name.replaceAll('\\', '/'));

for (const requiredFile of matrix.testFiles) {
  if (!testFiles.some((file) => file.endsWith(requiredFile))) {
    errors.push(`archivo integral ausente: ${requiredFile}`);
  }
}
for (const fragment of matrix.requiredGatewayTests) {
  const test = tests.find((candidate) => candidate.fullName.includes(fragment));
  if (!test) errors.push(`prueba Gateway ausente: ${fragment}`);
  else if (test.status !== 'passed') {
    errors.push(`prueba Gateway no aprobada (${test.status}): ${fragment}`);
  }
}
const bulkTest = tests.find((candidate) =>
  candidate.fullName.includes(
    'admits, rejects without commercial effects, retries through V4, and closes without duplicate effects',
  ),
);
if (!bulkTest || bulkTest.status !== 'passed') {
  errors.push('recorrido Bulk-Catalog integral ausente o no aprobado');
}

const executed = new Set(scenarioEvidence.scenarios ?? []);
for (const scenario of matrix.requiredBulkScenarios) {
  if (!executed.has(scenario))
    errors.push(`escenario Bulk ausente: ${scenario}`);
}
const skipped = tests.filter((test) =>
  ['pending', 'skipped', 'todo'].includes(test.status),
);
const failed = tests.filter((test) => test.status !== 'passed');
if (report.numFailedTests !== 0)
  errors.push(`${report.numFailedTests} tests fallidos`);
if (skipped.length !== 0) errors.push(`${skipped.length} tests omitidos`);
if (report.numPassedTests !== tests.length) {
  errors.push(
    'el contador de tests aprobados no coincide con las aserciones ejecutadas',
  );
}
if (tests.length < matrix.requiredGatewayTests.length + 1) {
  errors.push('se redujo la cantidad mínima de pruebas integrales previas');
}

console.log(
  JSON.stringify(
    {
      result: errors.length === 0 ? 'PASS' : 'FAIL',
      testFiles: testFiles.length,
      total: tests.length,
      passed: report.numPassedTests,
      failed: failed.length,
      skipped: skipped.length,
      requiredGatewayTests: matrix.requiredGatewayTests.length,
      requiredBulkScenarios: matrix.requiredBulkScenarios.length,
      missingOrFailed: errors,
    },
    null,
    2,
  ),
);
if (errors.length) process.exitCode = 1;
