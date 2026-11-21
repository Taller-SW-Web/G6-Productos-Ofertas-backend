import { Decimal } from '../domain/decimal.js';
import { normalizeCouponCode } from '../domain/promotion-rules.js';
import type { HttpCommercialContext } from '../infrastructure/http/commercial-http.js';
import type { InternalHttpReader } from '../infrastructure/http/internal-http.js';
import type {
  CouponDurableFactsSource,
  DurableCouponFacts,
} from './authoritative-coupon-evidence.js';
import { consumptionName, type CouponCommand } from './coupon-command.js';
import snapshotSchema from './g5-coupon-snapshot.schema.json' with { type: 'json' };
import { matchesSchema } from './schema-validator.js';

interface Snapshot {
  order_id: string;
  commercial_snapshot_ref: string;
  reservation_id: string;
  effective_at: string;
  customer_ref: string | null;
  channel_id: 'MARKETPLACE' | 'CHATBOT' | 'RETAIL';
  coupon_code: string;
  lines: {
    sku: string;
    product_id: string;
    quantity: number;
    currency: string;
    regular_price: string;
    offer_price: string | null;
  }[];
}

function subMillisecond(date: string): string {
  const fraction = /\.(\d+)(?:z|[+-]\d{2}:\d{2})$/i.exec(date)?.[1];
  return fraction?.slice(3).replace(/0+$/, '') ?? '';
}

export class G5CouponSnapshot implements CouponDurableFactsSource {
  constructor(
    private readonly ventas: Pick<InternalHttpReader, 'read'>,
    private readonly catalog: Pick<
      HttpCommercialContext,
      'verifyCouponCatalogLines'
    >,
  ) {}

  async read(
    command: CouponCommand,
    signal: AbortSignal,
  ): Promise<DurableCouponFacts> {
    const data = command.data;
    try {
      signal.throwIfAborted();
      if (
        command.name !== consumptionName ||
        ['.', '..'].includes(data.order_id)
      )
        throw new Error();
      const raw = await this.ventas.read(
        'obtenerSnapshotCuponG5',
        '/integraciones/productos/pedidos/' +
          encodeURIComponent(data.order_id) +
          '/evidencia-cupon',
        signal,
        false,
        command.correlation_id,
      );
      if (!matchesSchema(raw, snapshotSchema)) throw new Error();
      const snapshot = raw as Snapshot;
      if (
        snapshot.order_id !== data.order_id ||
        snapshot.commercial_snapshot_ref !== data.commercial_snapshot_ref ||
        snapshot.commercial_snapshot_ref !== snapshot.order_id ||
        snapshot.reservation_id.toLowerCase() !==
          data.reservation_id?.toLowerCase() ||
        (snapshot.customer_ref?.toLowerCase() ?? null) !==
          (data.customer_ref?.toLowerCase() ?? null) ||
        snapshot.channel_id !== data.channel_id ||
        normalizeCouponCode(snapshot.coupon_code) !==
          normalizeCouponCode(data.coupon_code ?? '') ||
        Date.parse(snapshot.effective_at) !==
          Date.parse(data.effective_at ?? '') ||
        subMillisecond(snapshot.effective_at) !==
          subMillisecond(data.effective_at ?? '') ||
        new Set(snapshot.lines.map((line) => line.sku)).size !==
          snapshot.lines.length ||
        new Set(snapshot.lines.map((line) => line.currency)).size !== 1
      )
        throw new Error();
      const lines = snapshot.lines.map((line) => {
        const regular = Decimal.from(line.regular_price);
        const offer =
          line.offer_price === null ? null : Decimal.from(line.offer_price);
        if (
          regular.coefficient <= 0n ||
          (offer && (offer.coefficient <= 0n || offer.compare(regular) > 0))
        )
          throw new Error();
        return {
          sku: line.sku,
          productId: line.product_id,
          quantity: line.quantity,
          currency: line.currency,
          regular: line.regular_price,
          offer: line.offer_price,
          active: true,
          channelEligible: true,
        };
      });
      await this.catalog.verifyCouponCatalogLines(
        lines,
        snapshot.channel_id,
        command.correlation_id,
        signal,
      );
      signal.throwIfAborted();
      return {
        orderId: snapshot.order_id,
        reservationId: snapshot.reservation_id,
        commercialSnapshotRef: snapshot.commercial_snapshot_ref,
        effectiveAt: snapshot.effective_at,
        customerRef: snapshot.customer_ref,
        channelId: snapshot.channel_id,
        couponCode: snapshot.coupon_code,
        snapshotDurable: true,
        basket: { lines },
      };
    } catch {
      throw new Error('COUPON_EVIDENCE_UNAVAILABLE');
    }
  }
}
