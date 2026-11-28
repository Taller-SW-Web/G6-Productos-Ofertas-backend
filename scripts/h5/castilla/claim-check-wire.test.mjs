import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const directory = fileURLToPath(new URL('.', import.meta.url));
const fixtureRoot = resolve(directory, '../../../apps/bulk-svc/test/fixtures/h5-claim-check');

test('claim-check fixtures reproduce 255 KiB and 257 KiB with matching digests', () => {
  const manifest = JSON.parse(readFileSync(join(fixtureRoot, 'manifest.json'), 'utf8'));
  for (const [index, kib] of [255, 257].entries()) {
    const fixture = manifest.files.find((item) => item.filename === `claim-check-${kib}kib.json`);
    assert.ok(fixture);
    const bytes = readFileSync(join(fixtureRoot, fixture.filename));
    assert.equal(bytes.length, kib * 1024);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), fixture.sha256);
    assert.equal(fixture.bytes, kib * 1024);
  }
  assert.equal(manifest.content_reference_only, true);
  assert.equal(manifest.actual_service_bus_wire_size_verified, false);
  assert.equal(manifest.service_bus_max_total_bytes, 256 * 1024);
});

test('fixture generator is deterministic and refuses to overwrite existing artifacts', () => {
  const one = mkdtempSync(join(tmpdir(), 'h5-claim-one-'));
  const two = mkdtempSync(join(tmpdir(), 'h5-claim-two-'));
  try {
    for (const output of [one, two]) {
      const result = spawnSync(process.execPath, [join(directory, 'generate-claim-check-fixtures.mjs'), output], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
    }
    const a = JSON.parse(readFileSync(join(one, 'manifest.json'), 'utf8'));
    const b = JSON.parse(readFileSync(join(two, 'manifest.json'), 'utf8'));
    assert.deepEqual(a.files.map((x) => [x.bytes, x.sha256]), b.files.map((x) => [x.bytes, x.sha256]));
    const again = spawnSync(process.execPath, [join(directory, 'generate-claim-check-fixtures.mjs'), one], { encoding: 'utf8' });
    assert.notEqual(again.status, 0);
  } finally {
    rmSync(one, { recursive: true, force: true }); rmSync(two, { recursive: true, force: true });
  }
});
