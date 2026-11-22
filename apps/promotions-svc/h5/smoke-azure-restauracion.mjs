import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { officialMigrations } from '../test/support/official-migrations.mjs';
import {
  CouponH5Operations,
  CouponH5Worker,
  prepareCouponH5Admission,
} from '../../../dist/apps/promotions-svc/coupons/coupon-h5-operations.js';
import { CouponH5DeliveryStore } from '../../../dist/apps/promotions-svc/coupons/coupon-h5-delivery.js';
import {
  CouponH5Runtime,
  nativeCouponH5Bus,
} from '../../../dist/apps/promotions-svc/coupons/coupon-h5-runtime.js';
import { CouponCommandProcessor } from '../../../dist/apps/promotions-svc/coupons/coupon-transactions.js';
import { encodeCouponH5Envelope } from '../../../dist/apps/promotions-svc/coupons/coupon-h5-envelope.js';

async function run() {
  assert.equal(process.env.G6_H5_AZURE_SMOKE, 'isolated-restoration');
  const namespace = 'g6-sb-h5-int-32cdqgbnlk7ow.servicebus.windows.net';
  const sha = process.env.G6_H5_SOURCE_SHA;
  assert.match(sha, /^[a-f0-9]{40}$/);
  const url = new URL(process.env.G6_H5_SQL_URL);
  assert.equal(url.protocol, 'postgresql:');
  assert.equal(url.hostname, '127.0.0.1');
  assert.match(url.pathname, /^\/g6_h5_azure_smoke_[a-z0-9]+$/);
  const admin = new Pool({
    connectionString: url.href,
    connectionTimeoutMillis: 1000,
  });
  const config = {
    namespace,
    managedIdentityClientId: process.env.G6_H5_AZURE_CLIENT_ID,
    couponCommandsEnabled: true,
  };
  assert.match(config.managedIdentityClientId, /^[a-f0-9-]{36}$/i);
  let pool, monitor, runtime;
  try {
    assert.equal(
      (await admin.query("SELECT to_regnamespace('promotions') AS schema"))
        .rows[0].schema,
      null,
    );
    const setup = await admin.connect();
    try {
      await setup.query(
        'BEGIN; CREATE ROLE po_promotions_owner NOLOGIN; CREATE ROLE po_promotions_runtime NOLOGIN; CREATE SCHEMA promotions AUTHORIZATION po_promotions_owner; SET LOCAL ROLE po_promotions_owner',
      );
      for (const sql of await officialMigrations()) await setup.query(sql);
      await setup.query(
        "SET LOCAL g6.promotions_h5_runtime_role='po_promotions_runtime'",
      );
      for (const file of [
        '0001_coupon_http_operations',
        '0002_coupon_http_runtime_role',
      ])
        await setup.query(
          await readFile(
            new URL(
              '../migrations-candidate/h5/' + file + '.sql',
              import.meta.url,
            ),
            'utf8',
          ),
        );
      await setup.query('COMMIT');
    } finally {
      setup.release(true);
    }
    pool = new Pool({
      connectionString: url.href,
      options: '-c role=po_promotions_runtime',
    });
    const operations = new CouponH5Operations(pool);
    const operation = randomUUID();
    const correlation = randomUUID();
    const order = 'G6-H5-AZURE-NO-PRIOR-USE-' + operation;
    const request = prepareCouponH5Admission(
      'RESTAURAR_CUPON',
      {
        operation_id: operation,
        order_id: order,
        consumption_operation_id: randomUUID(),
        cancellation_reason: 'ANULACION',
        cancelled_at: new Date().toISOString(),
      },
      operation,
      'modulo-ventas',
      correlation,
    );
    const { command } = request;
    const message = {
      messageId: command.message_id,
      correlationId: correlation,
      subject: command.name,
      body: encodeCouponH5Envelope(command),
      contentType: 'application/json',
      applicationProperties: {
        producer: 'promotions-svc',
        admitted_client: 'modulo-ventas',
        schema_version: 2,
        route_version: 1,
      },
    };
    const log = (step, result) =>
      console.log(
        JSON.stringify({
          step,
          sha,
          environment: 'rg-g6-sb-h5-int-fork',
          operation_id: operation,
          message_id: message.messageId,
          correlation_id: correlation,
          ...result,
        }),
      );
    monitor = nativeCouponH5Bus(config);
    assert.equal(
      (
        await monitor.receiver.peekMessages(1, {
          abortSignal: AbortSignal.timeout(12000),
        })
      ).length,
      0,
    );
    const open = () => {
      const actual = nativeCouponH5Bus(config);
      const complete = actual.receiver.completeMessage.bind(actual.receiver);
      const abandon = actual.receiver.abandonMessage.bind(actual.receiver);
      actual.receiver.completeMessage = async (received) => {
        const state = await operations.get(operation, order, 'modulo-ventas');
        assert.equal(state.status, 'REJECTED');
        assert.equal(received.messageId, message.messageId);
        await complete(received);
        settled++;
        log('settlement', {
          deliveries: settled,
          terminal: state.status,
          result_code: state.result.result_code,
        });
      };
      actual.receiver.abandonMessage = async (received) => {
        assert.equal(received.messageId, message.messageId);
        await abandon(received);
        abandoned++;
      };
      return actual;
    };
    const store = new CouponH5DeliveryStore(pool);
    const worker = new CouponH5Worker(
      operations,
      new CouponCommandProcessor(pool, {
        verify() {
          throw new Error('RESTORATION_MUST_NOT_READ_COMMERCIAL_EVIDENCE');
        },
      }),
    );
    let abandoned = 0;
    let settled = 0;
    let transient = true;
    const start = () => {
      const next = new CouponH5Runtime(
        config,
        store,
        {
          async process(candidate) {
            if (transient) {
              transient = false;
              throw new Error('ISOLATED_TRANSIENT_FAILURE');
            }
            await worker.process(candidate);
          },
        },
        open,
      );
      next.onApplicationBootstrap();
      return next;
    };
    const wait = async (predicate) => {
      const until = Date.now() + 55_000;
      while (Date.now() < until) {
        if (await predicate()) return;
        await delay(250);
      }
      throw new Error('AZURE_SMOKE_DEADLINE');
    };
    runtime = start();
    await wait(() => {
      try {
        runtime.assertAvailable();
        return true;
      } catch {
        return false;
      }
    });
    await runtime.onModuleDestroy();
    runtime = undefined;

    assert.equal((await operations.admit(request)).snapshot.status, 'ACCEPTED');
    const delivery = () =>
      admin.query(
        'SELECT attempts,sent_at FROM promotions.h5_coupon_outbox WHERE message_id=$1',
        [message.messageId],
      );
    assert.equal((await delivery()).rows[0].attempts, 0);
    log('admission', { status: 'ACCEPTED', outbox: true });
    runtime = start();
    await wait(() => settled === 1);
    assert.equal(abandoned, 1);
    assert.equal((await delivery()).rows[0].attempts, 1);
    assert.ok((await delivery()).rows[0].sent_at);
    await monitor.sender.sendMessages(message, {
      abortSignal: AbortSignal.timeout(12000),
    });
    await wait(() => settled === 2);
    assert.equal(
      (
        await admin.query(
          'SELECT 1 FROM promotions.inbox WHERE message_id=$1 AND completed_at IS NOT NULL',
          [message.messageId],
        )
      ).rowCount,
      1,
    );
    assert.equal(
      (
        await admin.query(
          'SELECT 1 FROM promotions.coupon_command_receipts WHERE operation_id=$1',
          [operation],
        )
      ).rowCount,
      1,
    );
    assert.equal(
      (
        await admin.query(
          'SELECT 1 FROM promotions.coupon_uses WHERE order_id=$1',
          [order],
        )
      ).rowCount,
      0,
    );
    log('result', {
      status: 'PASS',
      runtime_restarts: 1,
      abandoned,
      settled,
      inbox_rows: 1,
      receipt_rows: 1,
      coupon_effects: 0,
    });
  } finally {
    await runtime?.onModuleDestroy();
    await Promise.allSettled([monitor?.close(), pool?.end(), admin.end()]);
  }
}

run().catch((error) => {
  console.error(
    JSON.stringify({ step: 'error', code: error.code ?? error.name }),
  );
  process.exitCode = 1;
});
