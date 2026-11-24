import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const matrix = JSON.parse(
  await readFile(
    join(root, 'scripts/ci/bulk-h5-required-scenarios.json'),
    'utf8',
  ),
);

function verify(reportPath, scenariosPath) {
  return spawnSync(
    process.execPath,
    [
      'scripts/ci/verify-bulk-h5-e2e.mjs',
      reportPath,
      scenariosPath,
      'scripts/ci/bulk-h5-required-scenarios.json',
    ],
    { cwd: root, encoding: 'utf8' },
  );
}

test('el verificador acepta la matriz completa y rechaza un escenario ausente', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bulk-h5-verifier-'));
  try {
    const reportPath = join(directory, 'report.json');
    const scenariosPath = join(directory, 'scenarios.json');
    const gatewayTests = matrix.requiredGatewayTests.map((title) => ({
      fullName: title,
      status: 'passed',
    }));
    const report = {
      numPassedTests: gatewayTests.length + 1,
      numFailedTests: 0,
      numTotalTests: gatewayTests.length + 1,
      testResults: [
        {
          name: `/runner/${matrix.testFiles[0]}`,
          assertionResults: [
            {
              fullName:
                'admits, rejects without commercial effects, retries through V4, and closes without duplicate effects',
              status: 'passed',
            },
          ],
        },
        {
          name: `/runner/${matrix.testFiles[1]}`,
          assertionResults: gatewayTests,
        },
      ],
    };
    await writeFile(reportPath, JSON.stringify(report));
    await writeFile(
      scenariosPath,
      JSON.stringify({ scenarios: matrix.requiredBulkScenarios }),
    );
    const complete = verify(reportPath, scenariosPath);
    assert.equal(complete.status, 0, complete.stderr || complete.stdout);

    await writeFile(
      scenariosPath,
      JSON.stringify({ scenarios: matrix.requiredBulkScenarios.slice(1) }),
    );
    const missing = verify(reportPath, scenariosPath);
    assert.equal(missing.status, 1);
    assert.match(missing.stdout, /admission\.concurrent-identical-intent/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
