import test from 'node:test';
import assert from 'node:assert/strict';
import { adjudicateInt01L1Run } from './int01-l1-adjudication.mjs';

const expectedScenarioIds = ['INT01-A', 'INT01-B'];
const validSummary = () => ({
  schema_version: 1,
  suite: 'INT01_LOCAL_CATALOG_L1',
  status: 'PASS',
  total: 2,
  executed: 2,
  passed: 2,
  failed: 0,
  not_run: 0,
  unhandled_error_count: 0,
  cases: expectedScenarioIds.map((scenario_id) => ({
    scenario_id,
    status: 'PASS',
    execution: 'EXECUTED',
  })),
});
const adjudicate = (overrides = {}) =>
  adjudicateInt01L1Run({
    runnerExit: 0,
    runnerSignal: null,
    summary: validSummary(),
    expectedScenarioIds,
    ...overrides,
  });

test('accepts only a complete, consistent successful INT-01 reporter run', () => {
  const result = adjudicate();
  assert.equal(result.globallyValid, true);
  assert.equal(
    result.cases.every(
      (item) => item.status === 'PASS' && item.accepted_by_global_runner,
    ),
    true,
  );
});

test('rejects failed, interrupted, or timed-out Vitest process even when individual rows say PASS', () => {
  for (const override of [
    { runnerExit: 1 },
    { runnerExit: null, runnerSignal: 'SIGTERM' },
    { runnerExit: 1, runnerTimedOut: true },
    { runnerExit: null, runnerSpawnError: true },
  ]) {
    const result = adjudicate(override);
    assert.equal(result.globallyValid, false);
    assert.equal(
      result.errors.includes(
        override.runnerSignal ? 'RUNNER_INTERRUPTED' : 'RUNNER_EXIT_NOT_ZERO',
      ),
      true,
    );
    assert.equal(result.cases[0].status, 'NOT_ADJUDICATED');
    assert.equal(result.cases[0].observed_status, 'PASS');
  }
});

test('rejects failed global status, missing, duplicate, unexpected, or incomplete discoveries', () => {
  const mutations = [
    (summary) => {
      summary.status = 'FAIL';
    },
    (summary) => {
      summary.cases.pop();
      summary.total = 1;
      summary.executed = 1;
      summary.passed = 1;
    },
    (summary) => {
      summary.cases[1].scenario_id = summary.cases[0].scenario_id;
    },
    (summary) => {
      summary.cases[1].scenario_id = 'INT01-UNEXPECTED';
    },
    (summary) => {
      summary.cases[1].execution = 'NOT_EXECUTED';
      summary.cases[1].status = 'NOT_RUN';
      summary.not_run = 1;
      summary.executed = 1;
      summary.passed = 1;
    },
  ];
  for (const mutate of mutations) {
    const summary = validSummary();
    mutate(summary);
    assert.equal(adjudicate({ summary }).globallyValid, false);
  }
});

test('rejects inconsistent aggregate counters and unhandled reporter errors', () => {
  const badExecuted = validSummary();
  badExecuted.executed = 1;
  const badPassed = validSummary();
  badPassed.passed = 1;
  const unhandled = validSummary();
  unhandled.unhandled_error_count = 1;
  for (const summary of [badExecuted, badPassed, unhandled])
    assert.equal(adjudicate({ summary }).globallyValid, false);
});
