import assert from 'node:assert/strict';
import test from 'node:test';
import {
  evidenceByLevel,
  int01L1IndexStatus,
  int01L1ReportIntegrity,
} from './int01-preflight-coverage.mjs';

test('L0 contract PASS does not become L1 executed or passed when L1 is blocked', () => {
  const levels = evidenceByLevel({
    l0State: 'PASS',
    l0Executed: true,
    l1State: 'BLOCKED_DEPENDENCY',
    l1Execution: 'NOT_EXECUTED',
    l1EvidenceValid: false,
  });
  assert.deepEqual(levels.l0, {
    state: 'PASS',
    execution: 'EXECUTED',
    passed: true,
  });
  assert.deepEqual(levels.l1, {
    state: 'BLOCKED_DEPENDENCY',
    execution: 'NOT_EXECUTED',
    executed: false,
    passed: false,
    evidence_valid: false,
  });
});

test('index stays PARTIAL_B when all scenarios have no blockers/failures but one is partial', () => {
  const scenarios = [
    {
      l1: {
        state: 'PASS',
        execution: 'EXECUTED',
        passed: true,
        evidence_valid: true,
      },
    },
    {
      l1: {
        state: 'PARTIAL',
        execution: 'EXECUTED',
        passed: false,
        evidence_valid: true,
      },
    },
  ];
  assert.equal(int01L1IndexStatus(scenarios), 'PARTIAL_B');
});

test('index PASS requires complete, valid L1 evidence for every required scenario', () => {
  const complete = ['A', 'B'].map(() => ({
    l1: {
      state: 'PASS',
      execution: 'EXECUTED',
      passed: true,
      evidence_valid: true,
    },
  }));
  assert.equal(int01L1IndexStatus(complete), 'PASS');
  complete[1].l1.evidence_valid = false;
  assert.equal(int01L1IndexStatus(complete), 'PARTIAL_B');
});

test('L1 report integrity rejects a failed runner and inconsistent discovered/executed totals', () => {
  const report = {
    schema_version: 1,
    suite: 'INT01_LOCAL_CATALOG_L1',
    source_sha: 'a'.repeat(40),
    runner_exit_code: 0,
    runner_signal: null,
    runner_timed_out: false,
    suite_integrity: { status: 'PASS' },
    discovered: 1,
    executed: 1,
    skipped: 0,
    passed: 1,
    failed: 0,
    blocked: 0,
    cases: [
      {
        status: 'PASS',
        execution: 'EXECUTED',
        accepted_by_global_runner: true,
      },
    ],
    related_frontend_case: null,
  };
  assert.equal(int01L1ReportIntegrity(report, 'a'.repeat(40)).valid, true);
  report.runner_exit_code = 1;
  report.executed = 0;
  assert.deepEqual(int01L1ReportIntegrity(report, 'a'.repeat(40)).errors, [
    'L1_RUNNER_EXIT_NOT_ZERO',
    'L1_EXECUTION_COUNT_MISMATCH',
    'L1_CASE_EXECUTIONS_INCONSISTENT',
  ]);
});
