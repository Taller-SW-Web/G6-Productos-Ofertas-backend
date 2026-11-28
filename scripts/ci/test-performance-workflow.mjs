import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const ci = await readFile('.github/workflows/ci.yml', 'utf8');
const performance = await readFile('.github/workflows/performance-g6.yml', 'utf8');
const summary = await readFile('scripts/performance/summarize-selection.mjs', 'utf8');
const jobs = {
  catalog_http_performance: 'catalog',
  pricing_individual_http_performance: 'pricing',
  combos_h5_http_performance: 'combos',
  promotions_http_performance: 'promotions',
  promotions_paired_http_performance: 'promotions',
  gateway_inventory_http_performance: 'inventory-gateway',
};

assert.match(ci, /mode:[\s\S]*?options: \[ci, benchmark\]/);
assert.match(ci, /benchmark_focalizado:[\s\S]*?uses: \.\/\.github\/workflows\/performance-g6\.yml/);
assert.match(ci, /options: \[catalog, pricing, combos, promotions, inventory-gateway\]/);
assert.doesNotMatch(ci, /include_legacy/);
assert.match(performance, /^  workflow_dispatch:/m);
assert.match(performance, /^  workflow_call:/m);
assert.match(performance, /baseline_sha:/);
assert.match(performance, /git cat-file -e/);
assert.match(performance, /concurrency:/);
assert.doesNotMatch(performance, /include_legacy|RabbitMQ\s+reales|AMQP|bulk_http_performance|price_audit_http_performance|taxonomy_http_performance|combos_pricing_http_performance/);
const starts = [...performance.matchAll(/^  ([a-z][a-z0-9_]*):/gm)];
for (const [id, component] of Object.entries(jobs)) {
  const index = starts.findIndex((match) => match[1] === id);
  assert.notEqual(index, -1, `${id} presente`);
  const block = performance.slice(starts[index].index, starts[index + 1]?.index ?? performance.length);
  assert.ok(block.includes(`inputs.component == '${component}'`), `${id} seleccionable`);
  assert.match(block, /needs:[\s\S]*?- preflight/);
  assert.match(block, /timeout-minutes:/);
  assert.match(block, /actions\/upload-artifact/);
  assert.match(block, /if: always\(\)/);
  for (const key of ['baseline-first', 'candidate-first', 'candidate-second', 'baseline-second']) {
    if (id !== 'promotions_http_performance' && id !== 'gateway_inventory_http_performance') assert.ok(block.includes(key), `${id} conserva par ${key}`);
  }
}
for (const id of Object.keys(jobs)) assert.match(summary, new RegExp(id));
assert.match(summary, /SIN_UMBRAL_APROBADO/);
assert.match(summary, /if \(!complete\) process.exitCode = 1/);
assert.match(performance, /selection-summary\.json/);
console.log('PASS: benchmarks HTTP H5 seleccionables; legacy AMQP retirado; SHA y evidencia conservados.');
