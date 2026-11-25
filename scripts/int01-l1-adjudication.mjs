const isCount = (value) => Number.isSafeInteger(value) && value >= 0;

export function adjudicateInt01L1Run({
  runnerExit,
  runnerSignal = null,
  runnerTimedOut = false,
  runnerSpawnError = false,
  summary,
  expectedScenarioIds,
}) {
  const errors = [];
  const add = (code) => {
    if (!errors.includes(code)) errors.push(code);
  };
  const expected = Array.isArray(expectedScenarioIds)
    ? expectedScenarioIds
    : [];
  const expectedSet = new Set(expected);
  if (!expected.length || expectedSet.size !== expected.length)
    add('EXPECTED_SCENARIO_IDS_INVALID');
  if (runnerExit !== 0) add('RUNNER_EXIT_NOT_ZERO');
  if (runnerSignal) add('RUNNER_INTERRUPTED');
  if (runnerTimedOut) add('RUNNER_TIMED_OUT');
  if (runnerSpawnError) add('RUNNER_SPAWN_FAILED');
  if (!summary || typeof summary !== 'object') add('REPORTER_SUMMARY_MISSING');

  const rows = Array.isArray(summary?.cases) ? summary.cases : [];
  const ids = rows.map((row) => row?.scenario_id);
  const idSet = new Set(ids);
  if (
    rows.length !== expected.length ||
    ids.some((id) => typeof id !== 'string') ||
    idSet.size !== ids.length ||
    expected.some((id) => !idSet.has(id)) ||
    ids.some((id) => !expectedSet.has(id))
  )
    add('SCENARIO_DISCOVERY_MISMATCH');
  if (
    summary?.schema_version !== 1 ||
    summary?.suite !== 'INT01_LOCAL_CATALOG_L1'
  )
    add('REPORTER_SCHEMA_INVALID');
  if (summary?.status !== 'PASS') add('REPORTER_GLOBAL_STATUS_NOT_PASS');

  const counts = [
    'total',
    'executed',
    'passed',
    'failed',
    'not_run',
    'unhandled_error_count',
  ];
  if (counts.some((key) => !isCount(summary?.[key])))
    add('REPORTER_COUNTS_INVALID');
  if (isCount(summary?.total) && summary.total !== expected.length)
    add('DISCOVERED_COUNT_MISMATCH');
  if (isCount(summary?.executed) && summary.executed !== expected.length)
    add('EXECUTED_COUNT_MISMATCH');
  if (
    summary?.passed !== expected.length ||
    summary?.failed !== 0 ||
    summary?.not_run !== 0 ||
    summary?.unhandled_error_count !== 0
  )
    add('REPORTER_HAS_FAILURES_SKIPS_OR_UNHANDLED_ERRORS');
  if (
    isCount(summary?.passed) &&
    isCount(summary?.failed) &&
    isCount(summary?.executed) &&
    summary.passed + summary.failed !== summary.executed
  )
    add('REPORTER_EXECUTION_TOTAL_INCONSISTENT');
  if (
    isCount(summary?.executed) &&
    isCount(summary?.not_run) &&
    isCount(summary?.total) &&
    summary.executed + summary.not_run !== summary.total
  )
    add('REPORTER_DISCOVERY_TOTAL_INCONSISTENT');
  if (
    rows.some((row) => row?.status !== 'PASS' || row?.execution !== 'EXECUTED')
  )
    add('SCENARIO_NOT_SUCCESSFULLY_EXECUTED');

  const globallyValid = errors.length === 0;
  const byId = new Map(rows.map((row) => [row?.scenario_id, row]));
  const cases = expected.map((scenarioId) => {
    const row = byId.get(scenarioId);
    const observedStatus =
      row?.status === 'PASS' || row?.status === 'FAIL' ? row.status : 'NOT_RUN';
    return {
      scenario_id: scenarioId,
      status: !row
        ? 'FAIL'
        : globallyValid
          ? observedStatus
          : observedStatus === 'PASS'
            ? 'NOT_ADJUDICATED'
            : observedStatus === 'NOT_RUN'
              ? 'BLOCKED_DEPENDENCY'
              : observedStatus,
      observed_status: observedStatus,
      execution: row?.execution ?? 'NOT_EXECUTED',
      accepted_by_global_runner: globallyValid,
      evidence_level: row?.evidence_level ?? 'L1',
      providers_started: row?.providers_started ?? [],
      providers_queried: row?.providers_queried ?? [],
      providers_participating: row?.providers_participating ?? [],
      simulated_providers: row?.simulated_providers ?? [],
      identity_authorization: row?.identity_authorization ?? 'NOT_RUN',
    };
  });
  return {
    globallyValid,
    errors,
    cases,
    reporter: summary
      ? {
          status: summary.status ?? null,
          total: summary.total ?? null,
          executed: summary.executed ?? null,
          passed: summary.passed ?? null,
          failed: summary.failed ?? null,
          not_run: summary.not_run ?? null,
          unhandled_error_count: summary.unhandled_error_count ?? null,
        }
      : null,
  };
}
