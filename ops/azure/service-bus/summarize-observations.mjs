import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const destinationPattern = /^g6\.[a-z][a-z0-9.-]+$/;
const idPattern = /^[a-zA-Z0-9_-]{1,128}$/;
const shaPattern = /^[0-9a-f]{40}$/;

function requireValue(condition, code) {
  if (!condition) throw new Error(code);
}

function timestamp(value) {
  const time = Date.parse(value);
  requireValue(
    typeof value === 'string' &&
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value) &&
      Number.isFinite(time) &&
      new Date(time).toISOString() ===
        value.replace(/(?<=\d\d:\d\d:\d\d)Z$/, '.000Z'),
    'INVALID_UTC_TIMESTAMP',
  );
  return time;
}

function counter(value) {
  requireValue(Number.isSafeInteger(value) && value >= 0, 'INVALID_COUNTER');
  return value;
}

function distribution(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const result = { count: sorted.length };
  for (const percentile of [50, 95, 99]) {
    result['p' + percentile] =
      sorted[Math.ceil((percentile / 100) * sorted.length) - 1] ?? null;
  }
  return result;
}

function deliveryKey(record) {
  requireValue(
    idPattern.test(record.message_id ?? '') &&
      destinationPattern.test(record.destination ?? ''),
    'INVALID_DELIVERY_IDENTITY',
  );
  return record.destination + '/' + record.message_id;
}

// Input is a sanitized export of observations for one bounded run. No broker or database calls.
export function summarizeServiceBus({
  run_id,
  environment,
  source_sha,
  start_utc,
  end_utc,
  outbox,
  attempts,
  samples,
}) {
  requireValue(
    typeof run_id === 'string' &&
      idPattern.test(run_id) &&
      ['synthetic', 'isolated', 'azure'].includes(environment) &&
      shaPattern.test(source_sha ?? ''),
    'INVALID_RUN_METADATA',
  );
  const start = timestamp(start_utc);
  const end = timestamp(end_utc);
  const windowTime = (value) => {
    const time = timestamp(value);
    requireValue(time >= start && time <= end, 'TIMESTAMP_OUTSIDE_WINDOW');
    return time;
  };
  requireValue(
    end > start &&
      Array.isArray(outbox) &&
      outbox.length > 0 &&
      Array.isArray(attempts) &&
      Array.isArray(samples),
    'INVALID_OBSERVATION_WINDOW',
  );

  const deliveries = new Map();
  const intents = new Set();
  const queues = new Map();
  for (const row of outbox) {
    const key = deliveryKey(row);
    requireValue(
      idPattern.test(row.event_id ?? '') &&
        idPattern.test(row.operation_id ?? '') &&
        idPattern.test(row.producer ?? ''),
      'INVALID_OUTBOX_IDENTITY',
    );
    const intent = JSON.stringify([
      row.producer,
      row.event_id,
      row.destination,
    ]);
    requireValue(
      !deliveries.has(key) && !intents.has(intent),
      'DUPLICATE_OUTBOX_DELIVERY',
    );
    intents.add(intent);
    const enqueued =
      row.enqueued_utc === null ? null : windowTime(row.enqueued_utc);
    deliveries.set(key, { row, enqueued, attempts: [] });
    if (!queues.has(row.destination))
      queues.set(row.destination, { deliveries: [], samples: [] });
    queues.get(row.destination).deliveries.push(deliveries.get(key));
  }

  for (const attempt of attempts) {
    const delivery = deliveries.get(deliveryKey(attempt));
    requireValue(
      delivery &&
        delivery.row.operation_id === attempt.operation_id &&
        delivery.row.producer === attempt.producer &&
        delivery.enqueued !== null,
      'UNCORRELATED_ATTEMPT',
    );
    const received = windowTime(attempt.consumed_utc);
    const settled =
      attempt.settled_utc === null ? null : windowTime(attempt.settled_utc);
    const committed =
      attempt.committed_utc === null ? null : windowTime(attempt.committed_utc);
    const count = counter(attempt.delivery_count);
    requireValue(
      count > 0 &&
        received >= delivery.enqueued &&
        (settled === null || settled >= received) &&
        (committed === null ||
          (committed >= received &&
            (settled === null || committed <= settled))),
      'NON_MONOTONIC_DELIVERY',
    );
    requireValue(
      shaPattern.test(attempt.consumer_sha ?? '') &&
        ['complete', 'abandon', 'deadletter', 'unsettled'].includes(
          attempt.outcome,
        ) &&
        (attempt.outcome === 'unsettled' ? settled === null : settled !== null),
      'INVALID_SETTLEMENT',
    );
    delivery.attempts.push({
      count,
      received,
      settled,
      committed,
      outcome: attempt.outcome,
    });
  }

  for (const sample of samples) {
    requireValue(
      queues.has(sample.destination),
      'UNRECOGNIZED_SAMPLE_DESTINATION',
    );
    queues.get(sample.destination).samples.push({
      at: windowTime(sample.observed_utc),
      backlog: counter(sample.backlog),
      dlq: counter(sample.dlq_count),
      pending: counter(sample.outbox_pending),
      lease: counter(sample.lease_age_ms),
    });
  }

  return {
    run_id,
    environment,
    source_sha,
    window_ms: end - start,
    destinations: Object.fromEntries(
      [...queues].map(([destination, queue]) => {
        const commits = [];
        const settlements = [];
        let reDeliveries = 0;
        let abandoned = 0;
        let deadlettered = 0;
        let incomplete = 0;
        for (const delivery of queue.deliveries) {
          delivery.attempts.sort((a, b) => a.count - b.count);
          let terminal = false;
          let firstCommit = null;
          let previous = null;
          for (const attempt of delivery.attempts) {
            requireValue(!terminal, 'ATTEMPT_AFTER_TERMINAL_SETTLEMENT');
            requireValue(
              !previous ||
                (attempt.count > previous.count &&
                  attempt.received >=
                    (previous.settled ??
                      previous.committed ??
                      previous.received)),
              'INCONSISTENT_ATTEMPT_ORDER',
            );
            if (attempt.count > 1) reDeliveries++;
            if (attempt.outcome === 'abandon') abandoned++;
            firstCommit ??= attempt.committed;
            terminal = ['complete', 'deadletter'].includes(attempt.outcome);
            if (attempt.outcome === 'complete') {
              requireValue(
                firstCommit !== null,
                'COMPLETION_WITHOUT_DURABLE_COMMIT',
              );
              settlements.push(attempt.settled - delivery.enqueued);
              commits.push(firstCommit - delivery.enqueued);
            }
            if (attempt.outcome === 'deadletter') deadlettered++;
            previous = attempt;
          }
          if (!terminal) incomplete++;
        }

        const timeline = queue.samples.sort((a, b) => a.at - b.at);
        requireValue(
          timeline.length >= 2 &&
            timeline[0].at === start &&
            timeline.at(-1).at === end &&
            timeline.every(
              (sample, index) =>
                index === 0 || timeline[index - 1].at < sample.at,
            ),
          'INCOMPLETE_BACKLOG_SAMPLING',
        );
        let busySince = null;
        let drainMs = null;
        for (const sample of timeline) {
          if (sample.backlog + sample.pending > 0) {
            busySince ??= sample.at;
            drainMs = null;
          } else if (busySince !== null) {
            drainMs = sample.at - busySince;
            busySince = null;
          }
        }
        return [
          destination,
          {
            outbox_deliveries: queue.deliveries.length,
            completed: settlements.length,
            incomplete,
            redeliveries: reDeliveries,
            abandoned,
            deadlettered,
            dlq_count: timeline.at(-1).dlq,
            final_backlog: timeline.at(-1).backlog,
            outbox_pending: timeline.at(-1).pending,
            peak_lease_age_ms: Math.max(
              ...timeline.map((sample) => sample.lease),
            ),
            drain_ms: drainMs,
            completions_per_second:
              (settlements.length * 1_000) / (end - start),
            enqueue_to_commit_ms: distribution(commits),
            enqueue_to_settlement_ms: distribution(settlements),
          },
        ];
      }),
    ),
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const input = JSON.parse(await readFile(process.argv[2], 'utf8'));
    console.log(JSON.stringify(summarizeServiceBus(input), null, 2));
  } catch (error) {
    console.error(
      'PERF-05: ' +
        (error instanceof Error && /^[A-Z_]+$/.test(error.message)
          ? error.message
          : 'INVALID_INPUT'),
    );
    process.exitCode = 1;
  }
}
