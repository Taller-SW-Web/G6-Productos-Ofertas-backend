// Disposable PG/Rabbit only. fixture_* fields and adapters below are explicitly
// synthetic; GenericData is not a production projection contract.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { PromotionsAssignedEventDispatcher } from '../../../../dist/apps/promotions-svc/coupons/assigned-event-dispatcher.js';
import {
  assignedEventContracts,
  promotionsBrokerBinding,
} from '../../../../dist/apps/promotions-svc/coupons/event-contract.generated.js';
import { CouponCommandConsumer } from '../../../../dist/apps/promotions-svc/coupons/coupon-consumer.js';

export async function verifyAssignedEvents({
  pool,
  admin,
  connection,
  channel,
  commandHandler,
}) {
  const checks = [];
  const handler = 'promotions-assigned-events-v1';
  const ref = 'EXPLICIT-SYNTHETIC-' + randomUUID();
  const event = (name = 'catalog.product.deactivated', version = 1) => ({
    message_id: randomUUID(),
    schema_version: 1,
    occurred_at: '2026-10-23T12:00:00Z',
    correlation_id: 'isolated-assigned',
    causation_id: 'isolated-cause',
    producer: assignedEventContracts[name].producer,
    kind: 'event',
    name,
    data: {
      fixture_id: ref + '-' + name,
      fixture_version: version,
      fixture_active: false,
    },
  });
  const delivery = (body) => ({
    content: Buffer.from(JSON.stringify(body)),
    fields: { exchange: 'po.eventos.x', routingKey: body.name },
    properties: { contentType: 'application/json', messageId: body.message_id },
  });
  let failAfterWrite = false;
  const validate = (data) =>
    typeof data.fixture_id === 'string' &&
    Number.isSafeInteger(data.fixture_version) &&
    data.fixture_version > 0 &&
    typeof data.fixture_active === 'boolean';
  const adapters = Object.fromEntries(
    Object.keys(assignedEventContracts).map((name) => [
      name,
      {
        validate,
        apply: async (client, body) => {
          const data = body.data;
          const values = [
            data.fixture_id,
            JSON.stringify(data),
            data.fixture_version,
            body.occurred_at,
            body.message_id,
          ];
          if (name.startsWith('catalog.'))
            await client.query(
              `INSERT INTO promotions.catalog_projection
        (reference_type,reference_id,product_id,active,snapshot,source_version,source_occurred_at,source_message_id)
        VALUES ('PRODUCTO',$1,$1,false,$2::jsonb,$3,$4,$5)
        ON CONFLICT(reference_type,reference_id) DO UPDATE SET active=false,snapshot=EXCLUDED.snapshot,source_version=EXCLUDED.source_version,source_occurred_at=EXCLUDED.source_occurred_at,source_message_id=EXCLUDED.source_message_id`,
              values,
            );
          else if (name.startsWith('pricing.'))
            await client.query(
              `INSERT INTO promotions.price_projection
        (sku,channel_id,snapshot,source_version,source_occurred_at,source_message_id) VALUES ($1,NULL,$2::jsonb,$3,$4,$5)
        ON CONFLICT(sku,channel_id) DO UPDATE SET snapshot=EXCLUDED.snapshot,source_version=EXCLUDED.source_version,source_occurred_at=EXCLUDED.source_occurred_at,source_message_id=EXCLUDED.source_message_id`,
              values,
            );
          else
            await client.query(
              `INSERT INTO promotions.stock_projection
        (sku,availability,snapshot,source_version,source_occurred_at,source_message_id) VALUES ($1,'AGOTADO',$2::jsonb,$3,$4,$5)
        ON CONFLICT(sku) DO UPDATE SET availability='AGOTADO',snapshot=EXCLUDED.snapshot,source_version=EXCLUDED.source_version,source_occurred_at=EXCLUDED.source_occurred_at,source_message_id=EXCLUDED.source_message_id`,
              values,
            );
          if (failAfterWrite) await client.query('SELECT 1/0');
        },
      },
    ]),
  );
  const dispatcher = new PromotionsAssignedEventDispatcher(pool, adapters);
  dispatcher.assertReady();
  for (const name of Object.keys(assignedEventContracts)) {
    const body = event(name);
    assert.equal(
      await dispatcher.process(delivery(body), body.producer),
      'processed',
    );
    assert.equal(
      await dispatcher.process(delivery(body), body.producer),
      'replayed',
    );
    const receipt = await admin.query(
      'SELECT completed_at,result FROM promotions.inbox WHERE message_id=$1 AND handler=$2',
      [body.message_id, handler],
    );
    assert.ok(receipt.rows[0].completed_at);
    assert.deepEqual(receipt.rows[0].result, { handled: true });
    await assert.rejects(
      dispatcher.process(
        delivery({ ...body, data: { ...body.data, fixture_version: 2 } }),
        body.producer,
      ),
      /PROMOTIONS_ASSIGNED_EVENT_FAILED/,
    );
  }
  checks.push(
    'four assigned event envelopes: real PG Inbox/projection transaction, exact replay and conflicting message_id rejection, using explicitly synthetic field adapters',
  );
  const body = event();
  body.data.fixture_id += '-rollback';
  failAfterWrite = true;
  await assert.rejects(
    dispatcher.process(delivery(body), body.producer),
    /PROMOTIONS_ASSIGNED_EVENT_FAILED/,
  );
  failAfterWrite = false;
  assert.equal(
    (
      await admin.query(
        'SELECT count(*)::int n FROM promotions.inbox WHERE message_id=$1 AND handler=$2',
        [body.message_id, handler],
      )
    ).rows[0].n,
    0,
  );
  assert.equal(
    (
      await admin.query(
        'SELECT count(*)::int n FROM promotions.catalog_projection WHERE reference_id=$1',
        [body.data.fixture_id],
      )
    ).rows[0].n,
    0,
  );
  assert.equal(
    await dispatcher.process(delivery(body), body.producer),
    'processed',
  );
  const newest = { ...event(), data: { ...body.data, fixture_version: 3 } };
  await dispatcher.process(delivery(newest), newest.producer);
  const stale = { ...event(), data: { ...body.data, fixture_version: 2 } };
  await dispatcher.process(delivery(stale), stale.producer);
  assert.equal(
    String(
      (
        await admin.query(
          'SELECT source_version FROM promotions.catalog_projection WHERE reference_id=$1',
          [body.data.fixture_id],
        )
      ).rows[0].source_version,
    ),
    '3',
  );
  const unavailable = event();
  await assert.rejects(
    new PromotionsAssignedEventDispatcher(pool, {}).process(
      delivery(unavailable),
      unavailable.producer,
    ),
    /PROMOTIONS_EVENT_ADAPTER_UNAVAILABLE/,
  );
  await assert.rejects(
    dispatcher.process(delivery(event()), 'modulo-ventas'),
    /INVALID_ASSIGNED_EVENT/,
  );
  assert.equal(
    (
      await admin.query(
        'SELECT count(*)::int n FROM promotions.inbox WHERE message_id=$1',
        [unavailable.message_id],
      )
    ).rows[0].n,
    0,
  );
  checks.push(
    'adapter SQL failure rolls back projection and Inbox, retry succeeds, older versions cannot overwrite newer data and missing mapping/authenticated producer never completes Inbox',
  );

  async function waitFor(work) {
    for (let attempt = 0; attempt < 80; attempt++) {
      if (await work()) return;
      await delay(100);
    }
    throw new Error('ASSIGNED_BROKER_WAIT_TIMEOUT');
  }
  async function publish(value) {
    channel.publish(
      'po.eventos.x',
      value.name,
      Buffer.from(JSON.stringify(value)),
      {
        persistent: true,
        contentType: 'application/json',
        messageId: value.message_id,
        userId: 'guest',
      },
    );
    await channel.waitForConfirms();
  }
  const throughBroker = event('pricing.price.changed', 2);
  const receiving = await connection.createChannel();
  receiving.on('error', () => undefined);
  let acked = 0;
  let receiptAtAck;
  const ack = receiving.ack.bind(receiving);
  receiving.ack = (message) => {
    receiptAtAck = admin.query(
      'SELECT completed_at FROM promotions.inbox WHERE message_id=$1 AND handler=$2',
      [throughBroker.message_id, handler],
    );
    acked++;
    ack(message);
  };
  const worker = new CouponCommandConsumer(receiving, commandHandler, {
    // Only this disposable broker maps guest to fixture producers. Production
    // requires its own verified identity/ACL adapter and remains disabled.
    authenticatedActor: async () => {
      throw new Error('No coupon expected');
    },
    handleOtherAssignedEvent: async (message) => {
      assert.equal(message.properties.userId, 'guest');
      await dispatcher.process(
        message,
        assignedEventContracts[message.fields.routingKey].producer,
      );
    },
    failed: () => undefined,
  });
  try {
    await worker.start();
    await publish(throughBroker);
    await waitFor(async () => acked === 1);
    assert.ok((await receiptAtAck).rows[0].completed_at);
    await publish(throughBroker);
    await waitFor(async () => acked === 2);
  } finally {
    await worker.stop();
  }
  assert.equal(
    (
      await admin.query(
        'SELECT count(*)::int n FROM promotions.inbox WHERE message_id=$1 AND handler=$2',
        [throughBroker.message_id, handler],
      )
    ).rows[0].n,
    1,
  );
  const lost = event('inventory.stock.changed', 2);
  const interrupted = await connection.createChannel();
  await publish(lost);
  let first;
  await waitFor(async () => {
    first = await interrupted.get(promotionsBrokerBinding.queue, {
      noAck: false,
    });
    return !!first;
  });
  await dispatcher.process(first, lost.producer);
  await interrupted.close(); // No ACK: the real broker requeues this committed event.
  let redelivery;
  await waitFor(async () => {
    redelivery = await channel.get(promotionsBrokerBinding.queue, {
      noAck: false,
    });
    return !!redelivery;
  });
  assert.equal(redelivery.fields.redelivered, true);
  assert.equal(await dispatcher.process(redelivery, lost.producer), 'replayed');
  channel.ack(redelivery);
  checks.push(
    'shared rc.3 quorum queue routes real assigned events, ACK observes committed Inbox, duplicate publish and broker redelivery after lost ACK do not repeat projections',
  );
  return checks;
}
