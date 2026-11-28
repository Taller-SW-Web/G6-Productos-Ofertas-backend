import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

test('Gitleaks bloquea un secreto sintético y redacta la evidencia', () => {
  const fake = `ghp_${createHash('sha256').update('g6-ci-negative-fixture').digest('hex').slice(0, 36)}`;
  const run = spawnSync('gitleaks', ['stdin', '--no-banner', '--redact', '--exit-code', '42'], {
    input: `const token = "${fake}";`, encoding: 'utf8', windowsHide: true,
  });
  assert.ifError(run.error);
  assert.equal(run.status, 42);
  assert.doesNotMatch(`${run.stdout}${run.stderr}`, new RegExp(fake));
});
