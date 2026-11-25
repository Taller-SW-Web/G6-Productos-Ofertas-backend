import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { summarizeServiceBus } from './summarize-observations.mjs';

const cliPath = fileURLToPath(
  new URL('./summarize-observations.mjs', import.meta.url),
);

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
    complete_capture: true,
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

test('complete capture fixture correlates fan-out, out-of-order deliveries, pre/post-commit loss and DLQ by destination', () => {
  const summary = summarizeServiceBus(input());
  assert.equal(summary.status, 'COMPLETE');
  assert.equal(summary.capture_complete, true);
  assert.equal(summary.certification_eligible, false);
  assert.deepEqual(summary.incomplete_reasons, []);

  const result = summary.destinations;
  assert.equal(result[audit].status, 'COMPLETE');
  assert.equal(result[audit].certification_eligible, false);
  assert.deepEqual(result[audit].incomplete_sequences, []);
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

test('H09 requires both a complete capture and Azure Chile provenance for eligibility', () => {
  for (const environment of ['synthetic', 'isolated', 'azure']) {
    const capture = input();
    capture.environment = environment;
    capture.destination = 'chile-shared';
    const summary = summarizeServiceBus(capture);

    assert.equal(summary.capture_complete, true);
    assert.equal(summary.certification_eligible, environment === 'azure');
    assert.equal(
      summary.destinations[audit].certification_eligible,
      environment === 'azure',
    );
  }

  const noDestination = summarizeServiceBus({
    ...input(),
    environment: 'azure',
  });
  assert.equal(noDestination.capture_complete, true);
  assert.equal(noDestination.certification_eligible, false);

  const incomplete = summarizeServiceBus({
    ...input(),
    environment: 'azure',
    destination: 'chile-shared',
    complete_capture: false,
  });
  assert.equal(incomplete.capture_complete, false);
  assert.equal(incomplete.certification_eligible, false);
  assert.equal(incomplete.destinations[audit].certification_eligible, false);
});

test('truncated capture fixture marks run and affected metrics inconclusive', () => {
  const truncated = input();
  truncated.complete_capture = false;
  const summary = summarizeServiceBus(truncated);

  assert.equal(summary.status, 'INCONCLUSIVE');
  assert.equal(summary.capture_complete, false);
  assert.equal(summary.certification_eligible, false);
  assert.deepEqual(summary.incomplete_reasons, ['TRUNCATED_CAPTURE']);

  for (const destination of [audit, promotions]) {
    const metrics = summary.destinations[destination];
    assert.equal(metrics.status, 'INCONCLUSIVE');
    assert.equal(metrics.certification_eligible, false);
    assert.deepEqual(metrics.incomplete_reasons, ['TRUNCATED_CAPTURE']);
    assert.equal(metrics.completed, null);
    assert.equal(metrics.redeliveries, null);
    assert.equal(metrics.abandoned, null);
    assert.equal(metrics.deadlettered, null);
    assert.equal(metrics.drain_ms, null);
    assert.equal(metrics.completions_per_second, null);
    assert.equal(metrics.enqueue_to_commit_ms.status, 'INCONCLUSIVE');
    assert.equal(metrics.enqueue_to_commit_ms.p95, null);
    assert.equal(metrics.enqueue_to_settlement_ms.status, 'INCONCLUSIVE');
    assert.equal(metrics.enqueue_to_settlement_ms.p95, null);
  }
});

test('delivery_count gap fixture detects missing intermediate attempt even with out-of-order observations', () => {
  const gapped = input();
  // Remove attempt delivery_count=2 (keep out-of-order [3, 1]) and provide commit on attempt 3.
  gapped.attempts = gapped.attempts.filter(
    (entry) =>
      !(entry.message_id === 'message-1' && entry.delivery_count === 2),
  );
  gapped.attempts[0].committed_utc = utc(6);

  const summary = summarizeServiceBus(gapped);
  assert.equal(summary.status, 'INCONCLUSIVE');
  assert.equal(summary.capture_complete, false);
  assert.equal(summary.certification_eligible, false);
  assert.deepEqual(summary.incomplete_reasons, ['DELIVERY_COUNT_GAP']);

  const auditMetrics = summary.destinations[audit];
  assert.equal(auditMetrics.status, 'INCONCLUSIVE');
  assert.equal(auditMetrics.certification_eligible, false);
  assert.deepEqual(auditMetrics.incomplete_reasons, ['DELIVERY_COUNT_GAP']);
  assert.equal(auditMetrics.missing_attempts_count, 1);
  assert.deepEqual(auditMetrics.incomplete_sequences, [
    {
      destination: audit,
      message_id: 'message-1',
      observed_counts: [1, 3],
      missing_counts: [2],
      reasons: ['DELIVERY_COUNT_GAP'],
    },
  ]);
  assert.equal(auditMetrics.redeliveries, null);
  assert.equal(auditMetrics.abandoned, null);
  assert.equal(auditMetrics.completions_per_second, null);
  assert.equal(auditMetrics.enqueue_to_commit_ms.status, 'INCONCLUSIVE');
  assert.equal(auditMetrics.enqueue_to_commit_ms.p95, null);
  assert.equal(auditMetrics.enqueue_to_settlement_ms.status, 'INCONCLUSIVE');
  assert.equal(auditMetrics.enqueue_to_settlement_ms.p95, null);

  // Unaffected destination retains its complete metrics.
  assert.equal(summary.destinations[promotions].status, 'COMPLETE');
  assert.equal(summary.destinations[promotions].completed, 1);
});

test('marks sequence incomplete when first observed delivery_count starts above 1', () => {
  const lateStart = input();
  lateStart.attempts = lateStart.attempts.filter(
    (entry) =>
      !(
        entry.message_id === 'message-1' &&
        entry.destination === audit &&
        entry.delivery_count === 1
      ),
  );

  const summary = summarizeServiceBus(lateStart);
  assert.equal(summary.status, 'INCONCLUSIVE');
  assert.equal(summary.certification_eligible, false);
  assert.deepEqual(summary.incomplete_reasons, [
    'MISSING_INITIAL_DELIVERY_ATTEMPT',
  ]);
  assert.deepEqual(summary.destinations[audit].incomplete_sequences, [
    {
      destination: audit,
      message_id: 'message-1',
      observed_counts: [2, 3],
      missing_counts: [1],
      reasons: ['MISSING_INITIAL_DELIVERY_ATTEMPT'],
    },
  ]);
  assert.equal(summary.destinations[audit].redeliveries, null);
  assert.equal(
    summary.destinations[audit].enqueue_to_commit_ms.status,
    'INCONCLUSIVE',
  );
});

test('marks capture inconclusive when complete_capture attestation is omitted or enqueued delivery has zero observations', () => {
  const unattested = input();
  delete unattested.complete_capture;
  const unattestedResult = summarizeServiceBus(unattested);
  assert.equal(unattestedResult.status, 'INCONCLUSIVE');
  assert.deepEqual(unattestedResult.incomplete_reasons, [
    'UNCONFIRMED_CAPTURE_COMPLETENESS',
  ]);

  const missingDelivery = input();
  missingDelivery.attempts = missingDelivery.attempts.filter(
    (entry) => entry.destination !== promotions,
  );
  const missingResult = summarizeServiceBus(missingDelivery);
  assert.equal(missingResult.status, 'INCONCLUSIVE');
  assert.deepEqual(missingResult.incomplete_reasons, [
    'MISSING_DELIVERY_OBSERVATIONS',
  ]);
  assert.equal(missingResult.destinations[promotions].completed, null);
  assert.equal(missingResult.destinations[promotions].drain_ms, null);
});

test('CLI exits 0 for complete capture and 2 for incomplete/inconclusive capture', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'g6-perf05-cli-'));
  try {
    const completeFile = join(dir, 'complete.json');
    const truncatedFile = join(dir, 'truncated.json');
    await writeFile(completeFile, JSON.stringify(input()), 'utf8');
    const truncated = input();
    truncated.complete_capture = false;
    await writeFile(truncatedFile, JSON.stringify(truncated), 'utf8');

    const okOut = execFileSync(process.execPath, [cliPath, completeFile], {
      encoding: 'utf8',
    });
    assert.equal(JSON.parse(okOut).status, 'COMPLETE');

    let exitStatus = 0;
    let incOut = '';
    try {
      execFileSync(process.execPath, [cliPath, truncatedFile], {
        encoding: 'utf8',
      });
    } catch (error) {
      exitStatus = error.status;
      incOut = error.stdout;
    }
    assert.equal(exitStatus, 2);
    assert.equal(JSON.parse(incOut).status, 'INCONCLUSIVE');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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
