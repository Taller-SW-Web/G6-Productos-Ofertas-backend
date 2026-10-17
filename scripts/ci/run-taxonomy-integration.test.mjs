import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const runner = fileURLToPath(
  new URL('./run-taxonomy-integration.mjs', import.meta.url),
);

test('rejects a caller-supplied database URL before provisioning or connecting', () => {
  const resultado = spawnSync(process.execPath, [runner], {
    encoding: 'utf8',
    env: {
      ...process.env,
      TAXONOMY_TEST_DATABASE_URL:
        'postgresql://runner:secret@127.0.0.1:5432/shared',
    },
    windowsHide: true,
  });

  assert.equal(resultado.status, 1);
  assert.match(resultado.stderr, /TAXONOMY_TEST_DATABASE_URL está prohibida/);
  assert.doesNotMatch(resultado.stderr, /Docker run/);
});
