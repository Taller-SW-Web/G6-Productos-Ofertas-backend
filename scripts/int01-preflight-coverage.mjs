const executedStatuses = new Set(['EXECUTED', 'EXECUTED_FAILED']);

export function evidenceByLevel({
  l0State,
  l0Executed,
  l1State,
  l1Execution,
  l1EvidenceValid,
}) {
  return {
    l0: {
      state: l0State,
      execution: l0Executed ? 'EXECUTED' : 'NOT_EXECUTED',
      passed: l0State === 'PASS',
    },
    l1: {
      state: l1State,
      execution: l1Execution ?? 'NOT_EXECUTED',
      executed: executedStatuses.has(l1Execution),
      passed:
        l1State === 'PASS' &&
        l1Execution === 'EXECUTED' &&
        l1EvidenceValid === true,
      evidence_valid: l1EvidenceValid === true,
    },
  };
}

export function int01L1ReportIntegrity(report, expectedSourceSha) {
  const errors = [];
  const add = (error) => errors.push(error);
  if (!report || typeof report !== 'object') add('L1_REPORT_MISSING');
  if (report?.schema_version !== 1) add('L1_REPORT_SCHEMA_INVALID');
  if (report?.suite !== 'INT01_LOCAL_CATALOG_L1')
    add('L1_REPORT_SUITE_INVALID');
  if (report?.source_sha !== expectedSourceSha) add('L1_SOURCE_SHA_MISMATCH');
  const integrityStatus = report?.suite_integrity?.status;
  if (!['PASS', 'FAIL', 'NOT_RUN'].includes(integrityStatus))
    add('L1_REPORTER_GLOBAL_STATUS_INVALID');
  if (integrityStatus === 'PASS' && report?.runner_exit_code !== 0)
    add('L1_RUNNER_EXIT_NOT_ZERO');
  if (integrityStatus === 'NOT_RUN' && report?.runner_exit_code !== null)
    add('L1_RUNNER_NOT_RUN_EXIT_INVALID');
  if (report?.runner_signal !== null) add('L1_RUNNER_INTERRUPTED');
  if (report?.runner_timed_out !== false)
    add('L1_RUNNER_TIMEOUT_STATE_INVALID');

  const cases = Array.isArray(report?.cases) ? report.cases : [];
  const related = report?.related_frontend_case
    ? [report.related_frontend_case]
    : [];
  const rows = [...cases, ...related];
  const validCount = (value) => Number.isSafeInteger(value) && value >= 0;
  if (!Array.isArray(report?.cases)) add('L1_CASES_MISSING');
  if (report?.discovered !== rows.length) add('L1_DISCOVERY_COUNT_MISMATCH');
  if (
    !validCount(report?.executed) ||
    !validCount(report?.skipped) ||
    report.executed + report.skipped !== report.discovered
  )
    add('L1_EXECUTION_COUNT_MISMATCH');
  if (
    !['passed', 'failed', 'blocked'].every((key) =>
      validCount(report?.[key]),
    ) ||
    report.passed + report.failed + report.blocked !== report.discovered
  )
    add('L1_VERDICT_COUNT_MISMATCH');

  const observed = {
    passed: 0,
    failed: 0,
    blocked: 0,
    executed: 0,
    skipped: 0,
  };
  for (const row of rows) {
    if (
      row?.status === 'PASS' &&
      row?.execution === 'EXECUTED' &&
      row?.accepted_by_global_runner === true
    ) {
      observed.passed += 1;
      observed.executed += 1;
    } else if (row?.status === 'FAIL') {
      observed.failed += 1;
      if (executedStatuses.has(row?.execution)) observed.executed += 1;
      else observed.skipped += 1;
    } else if (row?.status === 'NOT_ADJUDICATED') {
      observed.blocked += 1;
      if (executedStatuses.has(row?.execution)) observed.executed += 1;
      else observed.skipped += 1;
    } else if (
      row?.status === 'BLOCKED_DEPENDENCY' &&
      row?.execution === 'NOT_EXECUTED'
    ) {
      observed.blocked += 1;
      observed.skipped += 1;
    } else {
      add('L1_CASE_STATUS_OR_EXECUTION_INVALID');
    }
  }
  if (
    observed.passed !== report?.passed ||
    observed.failed !== report?.failed ||
    observed.blocked !== report?.blocked
  )
    add('L1_CASE_VERDICTS_INCONSISTENT');
  if (
    observed.executed !== report?.executed ||
    observed.skipped !== report?.skipped
  )
    add('L1_CASE_EXECUTIONS_INCONSISTENT');

  const valid = errors.length === 0;
  return {
    valid,
    global_pass:
      valid &&
      integrityStatus === 'PASS' &&
      report?.runner_exit_code === 0 &&
      report?.runner_signal === null &&
      report?.runner_timed_out === false,
    errors,
  };
}

export function int01L1IndexStatus(scenarios) {
  if (!Array.isArray(scenarios) || scenarios.length === 0) return 'NOT_RUN';
  const l1 = scenarios.map((scenario) => scenario.l1);
  if (l1.some((item) => item?.state === 'FAIL')) return 'FAIL';
  if (l1.some((item) => item?.state === 'PARTIAL')) return 'PARTIAL_B';
  if (
    l1.every(
      (item) =>
        item?.state === 'PASS' &&
        item?.execution === 'EXECUTED' &&
        item?.passed === true &&
        item?.evidence_valid === true,
    )
  )
    return 'PASS';
  if (l1.some((item) => item?.state === 'PASS')) return 'PARTIAL_B';
  if (l1.some((item) => item?.state === 'BLOCKED_DEPENDENCY'))
    return 'BLOCKED_DEPENDENCY';
  return 'NOT_RUN';
}
