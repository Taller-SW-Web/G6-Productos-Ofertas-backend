import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AuthoritativeCouponEvidence } from '../../../../dist/apps/promotions-svc/coupons/authoritative-coupon-evidence.js';
import { CouponCommandProcessor } from '../../../../dist/apps/promotions-svc/coupons/coupon-transactions.js';

// These are internal, explicitly synthetic verified facts. No G5/Inventory
// response or authenticated external integration is simulated as production.
export async function verifyCouponEligibility({ pool, admin, command }) {
  const promotion = randomUUID();
  const coupon = randomUUID();
  await admin.query('BEGIN');
  try {
    await admin.query('SET LOCAL ROLE po_promotions_owner');
    await admin.query(
      `INSERT INTO promotions.promotions(id,name,discount_type,discount_value,modality,state,valid_from,valid_until,priority,enabled_channels)
       VALUES ($1,'Eligibility fixture','PORCENTAJE',10,'CUPON','ACTIVO','2026-10-01','2026-12-01',1,ARRAY['MARKETPLACE'])`,
      [promotion],
    );
    await admin.query(
      "INSERT INTO promotions.promotion_scopes(promotion_id,sku) VALUES ($1,'ELIGIBILITY-SKU')",
      [promotion],
    );
    await admin.query(
      'INSERT INTO promotions.combination_policy VALUES ($1,false,false,false)',
      [promotion],
    );
    await admin.query(
      `INSERT INTO promotions.coupons(id,promotion_id,code,state,minimum_amount,max_global_uses,cancellation_policy)
       VALUES ($1,$2,'ELIGIBILITY_FIXTURE','ACTIVO',100,1,'RESTAURAR_EN_CANCELACION')`,
      [coupon, promotion],
    );
    await admin.query('COMMIT');
  } catch (error) {
    await admin.query('ROLLBACK');
    throw error;
  }
  let mutate = (facts) => facts;
  let reads = 0;
  const source = {
    read: async ({ data }) => {
      reads++;
      return mutate({
        orderId: data.order_id,
        reservationId: data.reservation_id,
        commercialSnapshotRef: data.commercial_snapshot_ref,
        reservationConfirmed: true,
        snapshotDurable: true,
        couponCode: data.coupon_code,
        channelId: data.channel_id,
        customerRef: data.customer_ref ?? null,
        effectiveAt: data.effective_at,
        basket: {
          lines: [
            {
              sku: 'ELIGIBILITY-SKU',
              productId: 'ELIGIBILITY-PRODUCT',
              quantity: 1,
              regular: '100.00',
              offer: null,
              currency: 'PEN',
              active: true,
              channelEligible: true,
            },
          ],
        },
      });
    },
  };
  const processor = new CouponCommandProcessor(
    pool,
    new AuthoritativeCouponEvidence(source),
  );
  const input = () => command('ELIGIBILITY_FIXTURE');
  for (const change of [
    (f) => ({ ...f, reservationConfirmed: false }),
    (f) => ({ ...f, snapshotDurable: false }),
    (f) => ({ ...f, orderId: 'different-order' }),
    (f) => ({ ...f, reservationId: randomUUID() }),
    (f) => ({ ...f, commercialSnapshotRef: 'different-snapshot' }),
    (f) => ({ ...f, channelId: 'CHATBOT' }),
    (f) => ({ ...f, customerRef: randomUUID() }),
    (f) => ({ ...f, couponCode: 'OTHER' }),
    (f) => ({ ...f, effectiveAt: '2026-10-16T12:01:00Z' }),
    (f) => ({
      ...f,
      basket: {
        lines: f.basket.lines.map((l) => ({ ...l, regular: '99.99' })),
      },
    }),
    (f) => ({
      ...f,
      basket: {
        lines: f.basket.lines.map((l) => ({ ...l, sku: 'OUTSIDE-SCOPE' })),
      },
    }),
  ]) {
    mutate = change;
    const result = await processor.process(input(), 'modulo-ventas');
    assert.equal(result.data.result_code, 'COUPON_NOT_ELIGIBLE');
  }
  const malformed = input();
  mutate = (f) => ({
    ...f,
    basket: { lines: [{ ...f.basket.lines[0], quantity: 0 }] },
  });
  await assert.rejects(
    processor.process(malformed, 'modulo-ventas'),
    /COUPON_EVIDENCE_UNAVAILABLE/,
  );
  assert.equal(
    (
      await admin.query(
        'SELECT count(*) FROM promotions.coupon_command_receipts WHERE operation_id=$1',
        [malformed.operation_id],
      )
    ).rows[0].count,
    '0',
  );
  mutate = (f) => f;
  // The existing SQL limit remains authoritative, even for independent orders
  // whose evidence/scope/minimum all pass concurrently.
  const attempts = await Promise.all(
    [input(), input()].map((c) => processor.process(c, 'modulo-ventas')),
  );
  assert.equal(attempts.filter((r) => r.name.endsWith('.completed')).length, 1);
  assert.equal(
    attempts.find((r) => r.name.endsWith('.rejected')).data.result_code,
    'COUPON_GLOBAL_LIMIT',
  );
  const completed = attempts.find((r) => r.name.endsWith('.completed'));
  const receipt = await admin.query(
    'SELECT request_payload FROM promotions.coupon_command_receipts WHERE operation_id=$1',
    [completed.operation_id],
  );
  const replay = command('ELIGIBILITY_FIXTURE', {
    operation_id: completed.operation_id,
    data: receipt.rows[0].request_payload,
  });
  const beforeReplay = reads;
  assert.deepEqual(await processor.process(replay, 'modulo-ventas'), completed);
  assert.equal(reads, beforeReplay);
  assert.equal(
    (
      await admin.query(
        'SELECT count(*) FROM promotions.coupon_uses WHERE coupon_id=$1',
        [coupon],
      )
    ).rows[0].count,
    '1',
  );
  return [
    'authoritative eligibility: durable identities, scope, exact minimum, malformed facts rollback, concurrent last use and replay without evidence reload',
  ];
}
