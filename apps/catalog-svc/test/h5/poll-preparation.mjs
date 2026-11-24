import { setTimeout as sleep } from 'node:timers/promises';

const terminalStatuses = new Set(['COMPLETED', 'REJECTED']);
const pendingStatuses = new Set(['PENDING', 'ACCEPTED']);

export async function pollPreparation(readStatus, options = {}) {
  if (typeof readStatus !== 'function') throw new TypeError('POLL_READER_REQUIRED');
  const deadlineMs = options.deadlineMs ?? 30000;
  const intervalMs = options.intervalMs ?? 250;
  const maxAttempts = options.maxAttempts ?? 120;
  const now = options.now ?? Date.now;
  const wait = options.wait ?? sleep;
  if (![deadlineMs, intervalMs, maxAttempts].every(Number.isSafeInteger) || deadlineMs <= 0 || intervalMs < 0 || maxAttempts <= 0) throw new RangeError('POLL_BOUNDS_INVALID');
  const deadline = now() + deadlineMs;
  let attempts = 0;
  let lastStatus = 'NOT_OBSERVED';

  while (attempts < maxAttempts && now() < deadline) {
    const response = await readStatus();
    attempts += 1;
    if (!response || !Number.isInteger(response.httpStatus)) throw new Error('POLL_RESPONSE_INVALID');
    const status = response.preparationStatus;
    lastStatus = typeof status === 'string' ? status : 'UNKNOWN';
    if (response.httpStatus === 202) {
      lastStatus = 'HTTP_202_NON_TERMINAL';
    } else if (terminalStatuses.has(status)) {
      return { state: status, attempts, httpStatus: response.httpStatus };
    } else if (status === 'INDETERMINATE') {
      return { state: 'INCONCLUSIVE', reason: 'DEPENDENCY_INDETERMINATE', attempts, httpStatus: response.httpStatus };
    } else if (!pendingStatuses.has(status)) {
      throw new Error('POLL_STATUS_UNEXPECTED');
    }
    if (attempts < maxAttempts && now() < deadline) await wait(intervalMs);
  }
  return { state: 'INCONCLUSIVE', reason: 'POLL_DEADLINE_EXCEEDED', attempts, lastStatus };
}
