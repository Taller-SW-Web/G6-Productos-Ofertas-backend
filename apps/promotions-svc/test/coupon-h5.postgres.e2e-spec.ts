import { Pool } from 'pg';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  CouponH5Operations,
  prepareCouponH5Admission,
} from '../src/coupons/coupon-h5-operations.js';
import { CouponH5DeliveryStore } from '../src/coupons/coupon-h5-delivery.js';

// Explicit opt-in against an EMPTY disposable local database, never Supabase or
// a shared environment. This tests the candidate admission/lease SQL, not the
// historical coupon business migrations or an actual Azure namespace.
describe.skipIf(process.env.PROMOTIONS_H5_POSTGRES_TESTS !== '1')(
  'H5 coupon candidate PostgreSQL',
  () => {
    let pool: Pool;
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
      await pool.query('CREATE SCHEMA promotions');
      // Minimal legacy receipt fixture for admission compatibility; this suite
      // does not replace the historical SQL/business integration suite.
      await pool.query(`CREATE TABLE promotions.coupon_command_receipts
      (operation_id uuid PRIMARY KEY,request_fingerprint text,source_client_id text,intention text,status text,result_payload jsonb)`);
      await pool.query(
        readFileSync(
          'apps/promotions-svc/migrations-candidate/h5/0001_coupon_http_operations.sql',
          'utf8',
        ),
      );
      operations = new CouponH5Operations(pool);
      store = new CouponH5DeliveryStore(pool);
    });
    afterAll(async () => {
      await pool?.end();
    });
    const admit = () => {
      const operation_id = randomUUID();
      const order_id = 'PED-SQL-' + operation_id;
      return operations.admit(
        prepareCouponH5Admission(
          'CONSUMIR_CUPON',
          {
            operation_id,
            order_id,
            coupon_code: 'TEST',
            channel_id: 'MARKETPLACE',
            effective_at: new Date().toISOString(),
            reservation_id: randomUUID(),
            commercial_snapshot_ref: order_id,
          },
          operation_id,
          'modulo-ventas',
          randomUUID(),
        ),
      );
    };
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

    it('grants a dedicated runtime role only the privileges needed for H5 operations', async () => {
      const role = 'g6_promotions_h5_fixture_runtime';
      const migration = readFileSync(
        'apps/promotions-svc/migrations-candidate/h5/0002_coupon_http_runtime_role.sql',
        'utf8',
      );
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`CREATE ROLE ${role} NOLOGIN`);
        await client.query(`GRANT USAGE ON SCHEMA promotions TO ${role}`);
        await client.query('SELECT set_config($1,$2,true)', [
          'g6.promotions_h5_runtime_role',
          role,
        ]);
        await client.query(migration);
        await client.query(`SET LOCAL ROLE ${role}`);
        const permissions = await client.query(`SELECT
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
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    });
  },
);
