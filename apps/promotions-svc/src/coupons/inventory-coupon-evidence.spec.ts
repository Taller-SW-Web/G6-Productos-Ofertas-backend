import { randomUUID } from 'node:crypto';
import { InventoryCouponEvidence } from './inventory-coupon-evidence.js';
import { prepareCouponH5Admission } from './coupon-h5-operations.js';

const orderId = 'PED / prueba';
const reservationId = randomUUID();
const operationId = randomUUID();
const command = prepareCouponH5Admission(
  'CONSUMIR_CUPON',
  {
    operation_id: operationId,
    order_id: orderId,
    coupon_code: 'ENTRENA5',
    channel_id: 'MARKETPLACE',
    effective_at: '2026-11-21T12:00:00Z',
    reservation_id: reservationId,
    commercial_snapshot_ref: orderId,
  },
  operationId,
  'modulo-ventas',
  randomUUID(),
).command;

describe('H5 Inventory reservation evidence', () => {
  const signal = new AbortController().signal;
  const snapshot = () => ({
    reservation_id: reservationId,
    order_id: orderId,
    estado_persistido: 'ACTIVA',
    observed_at: new Date(Date.now() - 1000).toISOString(),
    expires_at: new Date(Date.now() + 60000).toISOString(),
    vigencia_efectiva: 'VIGENTE',
    permite_consumo_cupon: true,
    permite_pago: true,
  });

  it('reads the canonical private route by reservation and opaque order', async () => {
    const read = vi.fn(async () => snapshot());
    expect(
      await new InventoryCouponEvidence({ read }).confirms(command, signal),
    ).toBe(true);
    expect(read).toHaveBeenCalledWith(
      'obtenerEvidenciaReservaCuponInterno',
      `/interno/inventario/reservas/${reservationId}/evidencia-cupon?order_id=PED+%2F+prueba`,
      signal,
      true,
      command.correlation_id,
    );
  });

  it('distinguishes expired/absent reservations from invalid evidence', async () => {
    const active = snapshot();
    const expired = {
      ...active,
      expires_at: active.observed_at,
      vigencia_efectiva: 'VENCIDA',
      permite_pago: false,
      permite_consumo_cupon: false,
    };
    const read = vi
      .fn<() => Promise<unknown>>()
      .mockResolvedValueOnce(expired)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ ...active, order_id: 'OTHER-ORDER' })
      .mockResolvedValueOnce({ ...active, permite_pago: false });
    const evidence = new InventoryCouponEvidence({ read });
    await expect(evidence.confirms(command, signal)).resolves.toBe(false);
    await expect(evidence.confirms(command, signal)).resolves.toBe(false);
    await expect(evidence.confirms(command, signal)).rejects.toThrow(
      'COUPON_EVIDENCE_UNAVAILABLE',
    );
    await expect(evidence.confirms(command, signal)).rejects.toThrow(
      'COUPON_EVIDENCE_UNAVAILABLE',
    );
  });
});
