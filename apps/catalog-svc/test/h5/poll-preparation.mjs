import { setTimeout as sleep } from 'node:timers/promises';
import { classifyPreparationResponse } from './int01-contract-oracles.mjs';

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
    if (response.httpStatus !== 200) throw new Error('POLL_HTTP_STATUS_UNEXPECTED');
    const classified = classifyPreparationResponse(200, response.body, response.operationId ?? 'catalog-preparation-read');
    lastStatus = classified.state;
    if (classified.terminal) return { state: classified.state, attempts, httpStatus: response.httpStatus };
    if (attempts < maxAttempts && now() < deadline) await wait(intervalMs);
  }
  return { state: 'INCONCLUSIVE', reason: 'POLL_DEADLINE_EXCEEDED', attempts, lastStatus };
}
