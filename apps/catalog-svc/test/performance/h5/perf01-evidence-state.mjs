const requiredSuccess = Object.freeze([
  'preflightPassed',
  'postflightPassed',
  'executionComplete',
]);

export function adjudicatePerf01Evidence(evidence, { syntheticSmoke = false } = {}) {
  const failures = [];
  const unknown = [];
  for (const key of requiredSuccess) {
    if (evidence?.[key] === false) failures.push(key.toUpperCase());
    else if (evidence?.[key] !== true) unknown.push(key.toUpperCase());
  }
  if (evidence?.processExitCode !== 0) {
    if (Number.isInteger(evidence?.processExitCode)) failures.push('K6_RUNTIME_EXIT');
    else unknown.push('K6_RUNTIME_EXIT');
  }
  if (evidence?.runtimeFailures !== 0) {
    if (Number.isFinite(evidence?.runtimeFailures)) failures.push('K6_RUNTIME_FAILURES');
    else unknown.push('K6_RUNTIME_FAILURES');
  }
  if (!(Number.isFinite(evidence?.iterations) && evidence.iterations > 0)) {
    if (Number.isFinite(evidence?.iterations)) failures.push('NO_COMPLETED_ITERATIONS');
    else unknown.push('COMPLETED_ITERATIONS');
  }
  if (!(Number.isFinite(evidence?.unexpectedErrorRate) && evidence.unexpectedErrorRate < 0.01)) {
    if (Number.isFinite(evidence?.unexpectedErrorRate)) failures.push('UNEXPECTED_ERROR_RATE');
    else unknown.push('UNEXPECTED_ERROR_RATE');
  }
  if (!(Number.isFinite(evidence?.responses2xx) && evidence.responses2xx > 0)) {
    if (Number.isFinite(evidence?.responses2xx)) failures.push('NO_2XX_RESPONSES');
    else unknown.push('2XX_RESPONSES');
  }

  if (failures.length) return { status: 'FAIL', reasons: [...new Set(failures)] };
  if (unknown.length) return { status: 'INCONCLUSIVE', reasons: [...new Set(unknown)] };
  return { status: syntheticSmoke ? 'PASS_SYNTHETIC_SMOKE' : 'MEASURED', reasons: [] };
}
