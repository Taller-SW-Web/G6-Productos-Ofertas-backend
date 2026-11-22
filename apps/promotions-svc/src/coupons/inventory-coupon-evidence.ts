import type { InternalHttpReader } from '../infrastructure/http/internal-http.js';
import type { CouponCommand } from './coupon-command.js';
import { couponH5Schemas } from './coupon-h5-contract.generated.js';
import { matchesSchema, record } from './schema-validator.js';

export class InventoryCouponEvidence {
  constructor(private readonly inventory: Pick<InternalHttpReader, 'read'>) {}

  async confirms(
    command: CouponCommand,
    signal: AbortSignal,
  ): Promise<boolean> {
    const reservationId = command.data.reservation_id;
    if (!reservationId) throw new Error('COUPON_EVIDENCE_UNAVAILABLE');
    const orderId = command.data.order_id;
    const params = new URLSearchParams({ order_id: orderId });
    const value = await this.inventory.read(
      'obtenerEvidenciaReservaCuponInterno',
      `/interno/inventario/reservas/${encodeURIComponent(reservationId)}/evidencia-cupon?${params}`,
      signal,
      true,
      command.correlation_id,
    );
    if (value === null) return false;
    if (
      !record(value) ||
      !matchesSchema(value, couponH5Schemas.ReservationStatusSnapshot) ||
      String(value.reservation_id).toLowerCase() !==
        reservationId.toLowerCase() ||
      value.order_id !== orderId
    )
      throw new Error('COUPON_EVIDENCE_UNAVAILABLE');

    const active = value.estado_persistido === 'ACTIVA';
    const expiresAt = Date.parse(String(value.expires_at));
    const observedAt = Date.parse(String(value.observed_at));
    const validAtObservation = active && expiresAt > observedAt;
    if (
      value.permite_pago !== validAtObservation ||
      value.permite_consumo_cupon !== validAtObservation ||
      value.vigencia_efectiva !==
        (active ? (validAtObservation ? 'VIGENTE' : 'VENCIDA') : 'NO_APLICA')
    )
      throw new Error('COUPON_EVIDENCE_UNAVAILABLE');

    return validAtObservation && expiresAt > Date.now();
  }
}
