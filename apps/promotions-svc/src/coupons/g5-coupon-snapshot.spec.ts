import { randomUUID } from 'node:crypto';
import { prepareCouponH5Admission } from './coupon-h5-operations.js';
import { G5CouponSnapshot } from './g5-coupon-snapshot.js';
import { HttpCommercialContext } from '../infrastructure/http/commercial-http.js';
import { InternalHttpReader } from '../infrastructure/http/internal-http.js';

const order_id = 'PED /+í?';
const operationId = randomUUID();
const { command } = prepareCouponH5Admission(
  'CONSUMIR_CUPON',
  {
    operation_id: operationId,
    order_id,
    commercial_snapshot_ref: order_id,
    reservation_id: randomUUID(),
    customer_ref: randomUUID(),
    effective_at: '2026-11-21T16:00:00Z',
    channel_id: 'MARKETPLACE',
    coupon_code: 'ENTRENA5',
  },
  operationId,
  'modulo-ventas',
  randomUUID(),
);

const valid = {
  order_id,
  commercial_snapshot_ref: order_id,
  reservation_id: command.data.reservation_id,
  effective_at: '2026-11-21T11:00:00-05:00',
  customer_ref: command.data.customer_ref,
  channel_id: 'MARKETPLACE',
  coupon_code: 'ENTRENA5',
  lines: [
    {
      sku: 'ADI-ENT22-AZU-M',
      product_id: 'catalog-product',
      quantity: 1,
      currency: 'PEN',
      regular_price: '79.90',
      offer_price: null,
    },
  ],
};

describe('G5 private coupon evidence', () => {
  afterEach(() => vi.unstubAllGlobals());

  function fixture(payload: unknown = valid, status = 200) {
    const tokens = vi.fn(async ({ audience }) =>
      audience === 'api-ventas' ? 'ventas-token' : 'productos-token',
    );
    const ventas = 'https://g5.private.test';
    const catalog = 'https://catalog.private.test';
    const fetcher = vi.fn(async (url: string) => {
      if (url.startsWith(ventas)) return Response.json(payload, { status });
      if (url.endsWith('/contexto'))
        return Response.json({
          sku: 'ADI-ENT22-AZU-M',
          productId: 'catalog-product',
          active: true,
          eligible: true,
          isVariant: false,
        });
      return Response.json({
        product_id: 'catalog-product',
        categoria_id: 'category',
        marca_id: 'brand',
        marca: { marca_id: 'brand', name: 'Brand' },
        name: 'Product',
        slug: 'product',
        tipo_producto_id: 'simple',
        tiene_variantes: false,
        sku_base: 'ADI-ENT22-AZU-M',
        variants: [],
      });
    });
    vi.stubGlobal('fetch', fetcher);
    const source = new G5CouponSnapshot(
      new InternalHttpReader({
        origin: ventas,
        origins: { ventas },
        getServiceAccessToken: tokens,
      }),
      new HttpCommercialContext({
        origin: catalog,
        origins: { catalog },
        getServiceAccessToken: tokens,
      }),
    );
    return { fetcher, source, tokens };
  }

  it('reads the original order securely and checks the SKU and channel only in G6', async () => {
    const { fetcher, source, tokens } = fixture();
    const signal = AbortSignal.timeout(3000);
    const result = await source.read(command, signal);
    expect(result.basket.lines).toEqual([
      {
        sku: 'ADI-ENT22-AZU-M',
        productId: 'catalog-product',
        quantity: 1,
        currency: 'PEN',
        regular: '79.90',
        offer: null,
        active: true,
        channelEligible: true,
      },
    ]);
    expect(result).not.toHaveProperty('reservationConfirmed');
    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      'https://g5.private.test/api/v1/integraciones/productos/pedidos/PED%20%2F%2B%C3%AD%3F/evidencia-cupon',
      expect.objectContaining({
        redirect: 'error',
        signal,
        headers: expect.objectContaining({
          Authorization: 'Bearer ventas-token',
          'X-Correlation-Id': command.correlation_id,
        }),
      }),
    );
    expect(tokens).toHaveBeenNthCalledWith(
      1,
      {
        operationId: 'obtenerSnapshotCuponG5',
        audience: 'api-ventas',
        scope: 'ventas:pedidos:evidencia-cupon:leer',
      },
      signal,
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      'https://catalog.private.test/api/v1/productos/catalog-product?canal=MARKETPLACE',
      expect.anything(),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      3,
      'https://catalog.private.test/api/v1/productos/skus/ADI-ENT22-AZU-M/contexto',
      expect.anything(),
    );
  });

  it.each([
    { order_id: 'OTRO' },
    { commercial_snapshot_ref: 'OTRO' },
    { reservation_id: randomUUID() },
    { customer_ref: null },
    { effective_at: '2026-11-31T16:00:00Z' },
    { effective_at: '2026-11-21T16:00:01Z' },
    { effective_at: '2026-11-21T16:00:00.0001Z' },
    { channel_id: 'RETAIL' },
    { coupon_code: 'OTRO' },
    { eligible: true },
    { lines: [] },
    { lines: [valid.lines[0], valid.lines[0]] },
    { lines: [{ ...valid.lines[0], quantity: 0 }] },
    { lines: [{ ...valid.lines[0], offer_price: '80.00' }] },
  ])('rejects invalid snapshot %j before asking Catalog', async (patch) => {
    const { fetcher, source } = fixture({ ...valid, ...patch });
    await expect(
      source.read(command, AbortSignal.timeout(3000)),
    ).rejects.toThrow('COUPON_EVIDENCE_UNAVAILABLE');
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('rejects VENTAS as a snapshot channel while retaining modulo-ventas as sender identity', async () => {
    const { fetcher, source } = fixture({ ...valid, channel_id: 'VENTAS' });
    await expect(
      source.read(command, AbortSignal.timeout(3000)),
    ).rejects.toThrow('COUPON_EVIDENCE_UNAVAILABLE');
    expect(fetcher).toHaveBeenCalledOnce();
    expect(command.producer).toBe('modulo-ventas');
  });

  it.each([201, 401, 403, 404, 503])(
    'rejects HTTP %s from G5',
    async (status) => {
      const { source } = fixture(valid, status);
      await expect(
        source.read(command, AbortSignal.timeout(3000)),
      ).rejects.toThrow('COUPON_EVIDENCE_UNAVAILABLE');
    },
  );

  it('rejects a SKU identity not supported by Catalog', async () => {
    const { source } = fixture({
      ...valid,
      lines: [{ ...valid.lines[0], sku: 'OTHER' }],
    });
    await expect(
      source.read(command, AbortSignal.timeout(3000)),
    ).rejects.toThrow('COUPON_EVIDENCE_UNAVAILABLE');
  });

  it('does not start the read with a cancelled deadline', async () => {
    const { source, fetcher } = fixture();
    await expect(source.read(command, AbortSignal.abort())).rejects.toThrow(
      'COUPON_EVIDENCE_UNAVAILABLE',
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
});
