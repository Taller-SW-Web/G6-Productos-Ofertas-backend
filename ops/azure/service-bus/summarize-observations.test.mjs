import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeServiceBus } from './summarize-observations.mjs';

const utc = (seconds) =>
  new Date(Date.UTC(2026, 10, 24, 12, 0, seconds)).toISOString();
const audit = 'g6.price-audit.from.pricing';
const promotions = 'g6.promotions.from.pricing';
const sha = 'a'.repeat(40);

const input = () => {
  const first = {
    event_id: 'event-1',
    message_id: 'message-1',
    operation_id: 'operation-1',
    producer: 'pricing-svc',
    destination: audit,
    enqueued_utc: utc(1),
  };
  const fanout = { ...first, destination: promotions };
  const poison = {
    ...first,
    event_id: 'invalid-event',
    message_id: 'invalid-message',
    operation_id: 'invalid-operation',
  };
  const attempt = (row, count, received, end, outcome, committed = null) => ({
    ...row,
    delivery_count: count,
    consumed_utc: utc(received),
    outcome,
    settled_utc: end === null ? null : utc(end),
    committed_utc: committed === null ? null : utc(committed),
    consumer_sha: sha,
  });
  return {
    run_id: 'sample-1',
    source_sha: sha,
    environment: 'synthetic',
    start_utc: utc(0),
    end_utc: utc(10),
    outbox: [first, fanout, poison],
    attempts: [
      attempt(first, 3, 6, 7, 'complete'),
      attempt(fanout, 1, 2, 3, 'complete', 3),
      attempt(first, 1, 2, null, 'unsettled'),
      attempt(first, 2, 4, null, 'unsettled', 5),
      attempt(poison, 1, 4, 5, 'deadletter'),
    ],
    samples: [audit, promotions].flatMap((destination) => [
      {
        destination,
        observed_utc: utc(10),
        backlog: 0,
        outbox_pending: 0,
        lease_age_ms: 0,
        dlq_count: Number(destination === audit),
      },
      {
        destination,
        observed_utc: utc(0),
        backlog: 0,
        outbox_pending: 1,
        lease_age_ms: 500,
        dlq_count: 0,
      },
      {
        destination,
        observed_utc: utc(3),
        backlog: 1,
        outbox_pending: 0,
        lease_age_ms: 0,
        dlq_count: 0,
      },
    ]),
  };
};

test('correlates fan-out, out-of-order deliveries, pre/post-commit loss and DLQ by destination', () => {
  const result = summarizeServiceBus(input()).destinations;
  assert.equal(result[audit].redeliveries, 2);
  assert.equal(result[audit].completed, 1);
  assert.equal(result[audit].deadlettered, 1);
  assert.equal(result[audit].dlq_count, 1);
  assert.deepEqual(result[audit].enqueue_to_commit_ms, {
    count: 1,
    p50: 4000,
    p95: 4000,
    p99: 4000,
  });
  assert.equal(result[audit].enqueue_to_settlement_ms.p95, 6000);
  assert.equal(result[audit].drain_ms, 10000);
  assert.equal(result[promotions].completed, 1);
  assert.equal(result[promotions].completions_per_second, 0.1);
});

test('rejects uncorrelated deliveries and duplicate Outbox intents', () => {
  const sample = input();
  sample.attempts[0].message_id = 'unknown';
  assert.throws(() => summarizeServiceBus(sample), /UNCORRELATED_ATTEMPT/);
  const sameIntent = input();
  sameIntent.outbox.push({ ...sameIntent.outbox[0], message_id: 'duplicate' });
  assert.throws(
    () => summarizeServiceBus(sameIntent),
    /DUPLICATE_OUTBOX_DELIVERY/,
  );
});

test('rejects settlement before commit and duplicate completion', () => {
  const early = input();
  early.attempts[0].committed_utc = utc(8);
  assert.throws(() => summarizeServiceBus(early), /NON_MONOTONIC_DELIVERY/);
  const duplicate = input();
  duplicate.attempts.push({ ...duplicate.attempts[0], delivery_count: 4 });
  assert.throws(
    () => summarizeServiceBus(duplicate),
    /ATTEMPT_AFTER_TERMINAL_SETTLEMENT/,
  );
});

test('requires a commit before completion and full boundary sampling', () => {
  const uncommitted = input();
  uncommitted.attempts[3].committed_utc = null;
  assert.throws(
    () => summarizeServiceBus(uncommitted),
    /COMPLETION_WITHOUT_DURABLE_COMMIT/,
  );
  const gap = input();
  gap.samples.shift();
  assert.throws(() => summarizeServiceBus(gap), /INCOMPLETE_BACKLOG_SAMPLING/);
});

test('leaves drain time unknown when the observed queue stays blocked', () => {
  const blocked = input();
  blocked.samples[0].backlog = 2;
  assert.equal(summarizeServiceBus(blocked).destinations[audit].drain_ms, null);
});
