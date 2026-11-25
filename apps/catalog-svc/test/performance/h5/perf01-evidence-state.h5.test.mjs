import assert from 'node:assert/strict';
import test from 'node:test';
import { adjudicatePerf01Evidence } from './perf01-evidence-state.mjs';

const validRun = Object.freeze({
  preflightPassed: true,
  postflightPassed: true,
  executionComplete: true,
  processExitCode: 0,
  runtimeFailures: 0,
  iterations: 120,
  unexpectedErrorRate: 0,
  responses2xx: 120,
});

test('PERF-01 solo acredita MEASURED con preflight, postflight y runtime completos', () => {
  assert.deepEqual(adjudicatePerf01Evidence(validRun), { status: 'MEASURED', reasons: [] });
});

for (const [name, override] of [
  ['preflight fallido', { preflightPassed: false }],
  ['postflight fallido', { postflightPassed: false }],
  ['postflight incompleto', { postflightPassed: undefined }],
  ['ventana incompleta', { executionComplete: false }],
  ['proceso k6 fallido', { processExitCode: 99 }],
  ['runtime con fallos', { runtimeFailures: 1 }],
  ['sin iteraciones', { iterations: 0 }],
  ['tasa inesperada fuera de gate', { unexpectedErrorRate: 0.01 }],
  ['sin respuesta 2xx', { responses2xx: 0 }],
]) {
  test(`PERF-01 no acredita MEASURED cuando ${name}`, () => {
    const outcome = adjudicatePerf01Evidence({ ...validRun, ...override });
    assert.notEqual(outcome.status, 'MEASURED');
    assert.ok(outcome.reasons.length > 0);
  });
}

test('smoke sintético exitoso no se presenta como medición real', () => {
  assert.deepEqual(adjudicatePerf01Evidence(validRun, { syntheticSmoke: true }), { status: 'PASS_SYNTHETIC_SMOKE', reasons: [] });
});
