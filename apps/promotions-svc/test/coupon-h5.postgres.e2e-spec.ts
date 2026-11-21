import { Pool } from 'pg';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  ServiceBusError,
  type ServiceBusMessage,
  type ServiceBusReceivedMessage,
  type ServiceBusSender,
} from '@azure/service-bus';
import {
  CouponH5Operations,
  CouponH5Worker,
  couponH5Queue,
  prepareCouponH5Admission,
} from '../src/coupons/coupon-h5-operations.js';
import {
  CouponH5DeliveryHandler,
  CouponH5DeliveryStore,
  CouponH5Relay,
} from '../src/coupons/coupon-h5-delivery.js';
import {
  CouponCommandProcessor,
  couponH5EvidenceTimeoutMs,
} from '../src/coupons/coupon-transactions.js';
import { commandFingerprint } from '../src/coupons/coupon-command.js';
import {
  couponH5EnvelopeLimit,
  encodeCouponH5Envelope,
} from '../src/coupons/coupon-h5-envelope.js';
import { PromotionsOperationLogger } from '../src/infrastructure/logging/operation-logger.js';
import { officialMigrations } from './support/official-migrations.mjs';

// Explicit opt-in against an EMPTY disposable local database, never Supabase or
// a shared environment. PostgreSQL and the coupon processor are real. Evidence
// from G5 and Service Bus transport/settlement are test doubles.
describe.skipIf(process.env.PROMOTIONS_H5_POSTGRES_TESTS !== '1')(
  'H5 coupon candidate PostgreSQL',
  () => {
    let pool: Pool;
    let runtime: Pool;
    let operations: CouponH5Operations;
    let store: CouponH5DeliveryStore;
    beforeAll(async () => {
      const url = new URL(process.env.PROMOTIONS_H5_TEST_DATABASE_URL ?? '');
      if (
        !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
        !/^\/g6_promotions_h5_test_[a-z0-9_]+$/.test(url.pathname)
      )
        throw new Error('DISPOSABLE_LOCAL_DATABASE_REQUIRED');
      pool = new Pool({
        connectionString: url.href,
        max: 4,
        connectionTimeoutMillis: 2000,
      });
      const existing = await pool.query(
        "SELECT to_regnamespace('promotions') AS schema",
      );
      if (existing.rows[0].schema !== null)
        throw new Error('EMPTY_DATABASE_REQUIRED');
      await pool.query(
        'CREATE ROLE po_promotions_owner NOLOGIN; CREATE ROLE po_promotions_runtime NOLOGIN; CREATE SCHEMA promotions AUTHORIZATION po_promotions_owner',
      );
      const migrations = await officialMigrations();
      const setup = await pool.connect();
      try {
        await setup.query('BEGIN; SET LOCAL ROLE po_promotions_owner');
        for (const migration of migrations) await setup.query(migration);
        await setup.query(
          "SELECT set_config('g6.promotions_h5_runtime_role','po_promotions_runtime',true)",
        );
        for (const name of [
          '0001_coupon_http_operations',
          '0002_coupon_http_runtime_role',
        ])
          await setup.query(
            readFileSync(
              `apps/promotions-svc/migrations-candidate/h5/${name}.sql`,
              'utf8',
            ),
          );
        const promotionId = randomUUID();
        await setup.query(
          `INSERT INTO promotions.promotions(id,name,discount_type,discount_value,modality,state,valid_from,valid_until,priority,enabled_channels)
         VALUES ($1,'Synthetic H5 coupon','PORCENTAJE',10,'CUPON','ACTIVO','2026-10-01','2026-12-01',1,ARRAY['MARKETPLACE'])`,
          [promotionId],
        );
        await setup.query(
          "INSERT INTO promotions.promotion_scopes(promotion_id,sku) VALUES ($1,'SYNTHETIC-H5-SKU')",
          [promotionId],
        );
        await setup.query(
          'INSERT INTO promotions.combination_policy VALUES ($1,false,false,false)',
          [promotionId],
        );
        await setup.query(
          `INSERT INTO promotions.coupons(promotion_id,code,state,max_global_uses,cancellation_policy)
         VALUES ($1,'TEST','ACTIVO',20,'RESTAURAR_EN_CANCELACION')`,
          [promotionId],
        );
        await setup.query('COMMIT');
      } finally {
        setup.release(true);
      }
      runtime = new Pool({
        connectionString: url.href,
        options: '-c role=po_promotions_runtime',
        max: 2,
        connectionTimeoutMillis: 2000,
      });
      operations = new CouponH5Operations(runtime);
      store = new CouponH5DeliveryStore(runtime);
    }, 30000);
    beforeEach(async () => {
      await pool.query(
        'TRUNCATE promotions.h5_coupon_outbox, promotions.h5_coupon_operations',
      );
    });
    afterAll(async () => {
      await Promise.all([runtime?.end(), pool?.end()]);
    });
    const admission = () => {
      const operation_id = randomUUID();
      const order_id = 'PED-SQL-' + operation_id;
      return prepareCouponH5Admission(
        'CONSUMIR_CUPON',
        {
          operation_id,
          order_id,
          coupon_code: 'TEST',
          channel_id: 'MARKETPLACE',
          effective_at: '2026-11-21T16:00:00Z',
          reservation_id: randomUUID(),
          commercial_snapshot_ref: order_id,
        },
        operation_id,
        'modulo-ventas',
        randomUUID(),
      );
    };
    const admit = () => operations.admit(admission());
    const wire = () => {
      const sent: ServiceBusMessage[] = [];
      const send = vi.fn(async () => {});
      const sender = {
        createMessageBatch: async () => ({
          tryAddMessage: (message: ServiceBusMessage) => {
            sent.push(message);
            return true;
          },
        }),
        sendMessages: send,
      } as unknown as Pick<
        ServiceBusSender,
        'createMessageBatch' | 'sendMessages'
      >;
      return { sender, sent, send };
    };

    it('replays identical admissions and rejects changed content with one durable intent', async () => {
      const first = admission();
      const accepted = await operations.admit(first);
      const replay = await operations.admit({
        ...first,
        command: {
          ...first.command,
          message_id: randomUUID(),
          correlation_id: randomUUID(),
        },
      });
      expect(replay).toEqual({ ...accepted, replay: true });
      const changed = {
        ...first.command,
        data: { ...first.command.data, coupon_code: 'OTHER' },
      };
      await expect(
        operations.admit({
          ...first,
          command: changed,
          fingerprint: commandFingerprint(changed, first.actor),
        }),
      ).rejects.toThrow('IDEMPOTENCY_CONFLICT');
      const persisted = await pool.query(
        'SELECT message_id FROM promotions.h5_coupon_outbox',
      );
      expect(persisted.rows).toEqual([
        { message_id: first.command.message_id },
      ]);
    });

    it('rejects an oversized envelope before inserting an operation or intent', async () => {
      const first = admission();
      const command = {
        ...first.command,
        data: {
          ...first.command.data,
          coupon_code: 'é'.repeat(couponH5EnvelopeLimit / 2),
        },
      };
      await expect(
        operations.admit({
          ...first,
          command,
          fingerprint: commandFingerprint(command, first.actor),
        }),
      ).rejects.toThrow('VALIDACION');
      expect(
        (await pool.query('SELECT 1 FROM promotions.h5_coupon_operations'))
          .rows,
      ).toHaveLength(0);
      expect(
        (await pool.query('SELECT 1 FROM promotions.h5_coupon_outbox')).rows,
      ).toHaveLength(0);
    });
    it('rolls back operation if its delivery insert fails', async () => {
      await pool.query(
        'ALTER TABLE promotions.h5_coupon_outbox ADD CONSTRAINT fixture_reject CHECK(false)',
      );
      try {
        await expect(admit()).rejects.toMatchObject({
          code: '23514',
          constraint: 'fixture_reject',
        });
        expect(
          (
            await pool.query(
              'SELECT count(*)::int n FROM promotions.h5_coupon_operations',
            )
          ).rows[0].n,
        ).toBe(0);
      } finally {
        await pool.query(
          'ALTER TABLE promotions.h5_coupon_outbox DROP CONSTRAINT fixture_reject',
        );
      }
    });
    it('admits operation+intent atomically and gives one live claim across two relays', async () => {
      await admit();
      const claims = await Promise.all([store.claim(), store.claim()]);
      expect(claims.filter(Boolean)).toHaveLength(1);
      const claim = claims.find((c) => c !== undefined)!;
      expect(
        await store.finish({ ...claim, token: randomUUID() }, 'sent'),
      ).toBe(false);
      expect(await store.finish(claim, 'sent')).toBe(true);
      expect(await store.claim()).toBeUndefined();
    });
    it('recovers an expired lease and rejects its old confirmation token', async () => {
      await admit();
      const old = (await store.claim())!;
      await pool.query(
        "UPDATE promotions.h5_coupon_outbox SET lease_until=clock_timestamp()-interval '1 second' WHERE message_id=$1",
        [old.messageId],
      );
      const current = (await store.claim())!;
      expect(current.token).not.toBe(old.token);
      expect(await store.finish(old, 'sent')).toBe(false);
      expect(await store.finish(current, 'pending')).toBe(true);
      const row = (
        await pool.query(
          'SELECT sent_at,last_error FROM promotions.h5_coupon_outbox WHERE message_id=$1',
          [old.messageId],
        )
      ).rows[0];
      expect(row.sent_at).toBeNull();
      expect(row.last_error).toBe('SEND_NOT_CONFIRMED');
    });
    it('replays the same confirmed delivery if the operation never became terminal', async () => {
      await store.assertAvailable();
      await admit();
      const first = (await store.claim())!;
      expect(await store.finish(first, 'sent')).toBe(true);
      expect(await store.claim()).toBeUndefined();
      await pool.query(
        "UPDATE promotions.h5_coupon_outbox SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE message_id=$1",
        [first.messageId],
      );
      const replay = (await store.claim())!;
      expect(replay.messageId).toBe(first.messageId);
      expect(replay.command).toEqual(first.command);
      expect(replay.token).not.toBe(first.token);
      expect(await store.finish(first, 'sent')).toBe(false);
      expect(await store.finish(replay, 'sent')).toBe(true);
    });

    it('quarantines old oversized intent and only requeues a broker refusal after authorized remediation', async () => {
      const legacy = admission();
      await operations.admit(legacy);
      // Simulate the bytes committed before the size guard was added.
      const command = {
        ...legacy.command,
        data: {
          ...legacy.command.data,
          coupon_code: 'é'.repeat(couponH5EnvelopeLimit / 2),
        },
      };
      await pool.query(
        'UPDATE promotions.h5_coupon_operations SET command=$2,request_fingerprint=$3 WHERE operation_id=$1',
        [
          command.operation_id,
          command,
          commandFingerprint(command, legacy.actor),
        ],
      );
      const { sender, sent, send } = wire();
      const lines: string[] = [];
      const publisher = new CouponH5Relay(
        store,
        sender,
        new PromotionsOperationLogger((line) => lines.push(line)),
      );
      expect(await publisher.publishOne()).toBe('too-large');
      expect(sent).toHaveLength(0);

      const refused = admission();
      await operations.admit(refused);
      send.mockRejectedValueOnce(
        new ServiceBusError('synthetic broker detail', 'MessageSizeExceeded'),
      );
      expect(await publisher.publishOne()).toBe('too-large');
      expect(await publisher.publishOne()).toBe('empty');
      expect(lines.map((line) => JSON.parse(line))).toEqual(
        [command, refused.command].map((c) => ({
          timestamp: expect.any(String),
          level: 'error',
          service: 'promotions-svc',
          code: 'MESSAGE_TOO_LARGE',
          operation_id: c.operation_id,
          message_id: c.message_id,
        })),
      );
      const frozen = await pool.query(`SELECT message_id, last_error, sent_at,
        next_attempt_at='infinity'::timestamptz AS quarantined
        FROM promotions.h5_coupon_outbox ORDER BY created_at`);
      expect(frozen.rows).toEqual(
        [command, refused.command].map((c) => ({
          message_id: c.message_id,
          last_error: 'MESSAGE_TOO_LARGE',
          sent_at: null,
          quarantined: true,
        })),
      );
      for (const c of [command, refused.command]) {
        expect(
          await operations.get(c.operation_id, c.data.order_id, legacy.actor),
        ).toMatchObject({ status: 'ACCEPTED', result: null });
      }

      expect(
        encodeCouponH5Envelope(refused.command).length,
      ).toBeLessThanOrEqual(couponH5EnvelopeLimit);
      const requeued = await pool.query(
        `UPDATE promotions.h5_coupon_outbox AS d SET next_attempt_at=clock_timestamp(),last_error=NULL
        FROM promotions.h5_coupon_operations AS o
        WHERE d.message_id=$1 AND d.operation_id=$2 AND o.operation_id=d.operation_id
          AND o.status='ACCEPTED' AND d.last_error='MESSAGE_TOO_LARGE'
          AND d.next_attempt_at='infinity'::timestamptz AND d.lease_token IS NULL AND d.sent_at IS NULL`,
        [refused.command.message_id, refused.command.operation_id],
      );
      expect(requeued.rowCount).toBe(1);
      expect(await publisher.publishOne()).toBe('sent');
      expect(sent.map((message) => message.messageId)).toEqual([
        refused.command.message_id,
        refused.command.message_id,
      ]);
      expect(sent[1].body).toEqual(sent[0].body);
      expect(await publisher.publishOne()).toBe('empty');
    });

    it('recovers ambiguous delivery after restart and commits a single effect before settlement', async () => {
      const { command, actor, fingerprint } = admission();
      const {
        operation_id: operationId,
        data: { order_id: orderId },
      } = command;
      await operations.admit({
        command,
        actor,
        fingerprint,
        kind: 'CONSUMIR_CUPON',
      });
      const { sender, sent, send } = wire();
      send.mockRejectedValueOnce(
        new Error('synthetic timeout after transport accepted'),
      );
      expect(await new CouponH5Relay(store, sender).publishOne()).toBe(
        'pending',
      );
      const pending = await pool.query(
        'SELECT last_error, sent_at, attempts FROM promotions.h5_coupon_outbox WHERE message_id=$1',
        [command.message_id],
      );
      expect(pending.rows).toEqual([
        { last_error: 'SEND_NOT_CONFIRMED', sent_at: null, attempts: 1 },
      ]);
      await pool.query(
        "UPDATE promotions.h5_coupon_outbox SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE message_id=$1",
        [command.message_id],
      );
      const reopened = new CouponH5Operations(runtime);
      expect(
        await new CouponH5Relay(
          new CouponH5DeliveryStore(runtime),
          sender,
        ).publishOne(),
      ).toBe('sent');
      expect(sent.map(({ messageId, body }) => [messageId, body])).toEqual([
        [command.message_id, encodeCouponH5Envelope(command)],
        [command.message_id, encodeCouponH5Envelope(command)],
      ]);

      const verify = vi.fn(async (_command, signal: AbortSignal) => {
        await delay(1200, undefined, { signal });
        return {
          reservationConfirmed: true,
          snapshotDurable: true,
          eligible: true,
          orderId,
          reservationId: command.data.reservation_id!,
          commercialSnapshotRef: orderId,
        };
      });
      const completeMessage = vi.fn(async () => {
        expect(await operations.get(operationId, orderId, actor)).toMatchObject(
          { status: 'COMPLETED' },
        );
      });
      const settlement = {
        completeMessage,
        abandonMessage: vi.fn(),
        deadLetterMessage: vi.fn(),
      };
      const handle = (timeout?: number) =>
        new CouponH5DeliveryHandler(
          couponH5Queue,
          new CouponH5Worker(
            reopened,
            new CouponCommandProcessor(runtime, { verify }, undefined, timeout),
          ),
          settlement,
        );
      const message = sent[0] as unknown as ServiceBusReceivedMessage;
      const effects = async () =>
        (
          await pool.query(
            `SELECT
        (SELECT count(*)::int FROM promotions.inbox WHERE message_id=$1) AS inbox,
        (SELECT count(*)::int FROM promotions.coupon_command_receipts WHERE operation_id=$2) AS receipts,
        (SELECT count(*)::int FROM promotions.coupon_uses WHERE order_id=$3) AS uses`,
            [command.message_id, operationId, orderId],
          )
        ).rows[0];

      // Default H4 budget rejects the same 1200 ms dependency that H5 can use.
      await handle().handle(message);
      expect(verify.mock.calls[0][1].aborted).toBe(true);
      expect(await effects()).toEqual({ inbox: 0, receipts: 0, uses: 0 });
      verify.mockImplementationOnce(async (_command, signal) => {
        await delay(3500, undefined, { signal });
        throw new Error('fixture should have been cancelled');
      });
      const h5 = handle(couponH5EvidenceTimeoutMs);
      await h5.handle(message);
      expect(verify.mock.calls[1][1].aborted).toBe(true);
      expect(settlement.abandonMessage).toHaveBeenCalledTimes(2);
      expect(completeMessage).not.toHaveBeenCalled();
      expect(await effects()).toEqual({ inbox: 0, receipts: 0, uses: 0 });
      const locks = await pool.query(
        `SELECT
        pg_try_advisory_xact_lock(hashtextextended('promotions:order:' || $1,0)) AS by_order,
        pg_try_advisory_xact_lock(hashtextextended('promotions:operation:' || $2,0)) AS by_operation`,
        [orderId, operationId],
      );
      expect(locks.rows[0]).toEqual({ by_order: true, by_operation: true });
      const idle = await pool.query(
        "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND state LIKE 'idle in transaction%'",
      );
      expect(idle.rows).toHaveLength(0);

      completeMessage.mockImplementationOnce(async () => {
        expect(await operations.get(operationId, orderId, actor)).toMatchObject(
          { status: 'COMPLETED' },
        );
        throw new Error('synthetic settlement lock lost');
      });
      await expect(h5.handle(message)).rejects.toThrow(
        'synthetic settlement lock lost',
      );
      await handle(couponH5EvidenceTimeoutMs).handle(
        sent[1] as unknown as ServiceBusReceivedMessage,
      );
      expect(verify).toHaveBeenCalledTimes(3);
      expect(verify.mock.calls[2][1].aborted).toBe(false);
      expect(completeMessage).toHaveBeenCalledTimes(2);
      expect(settlement.deadLetterMessage).not.toHaveBeenCalled();
      expect(await effects()).toEqual({ inbox: 1, receipts: 1, uses: 1 });

      // Simulate a terminal age of 30 days without waiting for the calendar.
      await pool.query(
        `UPDATE promotions.h5_coupon_operations SET
        completed_at=clock_timestamp()-interval '30 days',
        updated_at=clock_timestamp()-interval '30 days' WHERE operation_id=$1`,
        [operationId],
      );
      const retained = await reopened.get(operationId, orderId, actor);
      expect(retained?.status).toBe('COMPLETED');
      expect(
        await reopened.admit({
          command,
          actor,
          fingerprint,
          kind: 'CONSUMIR_CUPON',
        }),
      ).toEqual({ replay: true, snapshot: retained });
      expect(await effects()).toEqual({ inbox: 1, receipts: 1, uses: 1 });
      expect(await store.claim()).toBeUndefined();
    }, 15000);

    it('grants a dedicated runtime role only the privileges needed for H5 operations', async () => {
      const permissions = await runtime.query(`SELECT
          has_table_privilege(current_user,'promotions.h5_coupon_operations','INSERT') AS admit,
          has_table_privilege(current_user,'promotions.h5_coupon_outbox','UPDATE') AS deliver,
          has_table_privilege(current_user,'promotions.h5_coupon_outbox','DELETE') AS purge,
          has_schema_privilege(current_user,'promotions','CREATE') AS ddl`);
      expect(permissions.rows[0]).toEqual({
        admit: true,
        deliver: true,
        purge: false,
        ddl: false,
      });
      await expect(
        runtime.query(
          'DELETE FROM promotions.h5_coupon_operations WHERE false',
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        runtime.query(
          'ALTER TABLE promotions.h5_coupon_outbox ADD COLUMN fixture_ddl boolean',
        ),
      ).rejects.toMatchObject({ code: '42501' });
    });
  },
);
