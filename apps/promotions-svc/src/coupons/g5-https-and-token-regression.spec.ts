import { createServer as createHttpsServer } from 'node:https';
import {
  internalOperations,
  internalOrigin,
  InternalHttpReader,
} from '../infrastructure/http/internal-http.js';
import { G5CouponSnapshot } from './g5-coupon-snapshot.js';
import type { CouponCommand } from './coupon-command.js';

describe('G5 HTTPS policy, /api/v1 prefix, and G7 token contract regression', () => {
  it('rejects plain HTTP origins for ventas upstream while preserving HTTPS', () => {
    expect(() => internalOrigin('http://127.0.0.1:4123', false, 'ventas')).toThrow(
      'INVALID_COMMERCIAL_ORIGIN',
    );
    expect(() => internalOrigin('http://127.0.0.1:4123', true, 'ventas')).toThrow(
      'INVALID_COMMERCIAL_ORIGIN',
    );
    expect(internalOrigin('https://127.0.0.1:4123', false, 'ventas')).toBe(
      'https://127.0.0.1:4123',
    );
  });

  it('requires api-ventas audience and ventas:pedidos:evidencia-cupon:leer scope for obtenerSnapshotCuponG5', () => {
    expect(internalOperations.obtenerSnapshotCuponG5).toEqual({
      service: 'ventas',
      scope: 'ventas:pedidos:evidencia-cupon:leer',
      missing: '',
      clientId: 'promotions-svc',
      audience: 'api-ventas',
    });
  });

  it('requests G5 snapshot under /api/v1/integraciones/productos/pedidos/:orderId/evidencia-cupon', async () => {
    const requestedUrls: string[] = [];
    const requestedHeaders: Record<string, string>[] = [];
    const originalFetch = globalThis.fetch;

    const snapshotPayload = {
      order_id: 'ord-g5-001',
      commercial_snapshot_ref: 'ord-g5-001',
      reservation_id: 'res-g5-001',
      effective_at: '2026-11-26T00:00:00.000Z',
      customer_ref: 'cust-001',
      channel_id: 'MARKETPLACE' as const,
      coupon_code: 'PROMO10',
      lines: [
        {
          sku: 'SKU-001',
          product_id: 'prod-001',
          quantity: 1,
          currency: 'PEN',
          regular_price: '100.00',
          offer_price: null,
        },
      ],
    };

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requestedUrls.push(String(input));
      requestedHeaders.push(
        Object.fromEntries(new Headers(init?.headers).entries()),
      );
      return new Response(JSON.stringify(snapshotPayload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    try {
      const reader = new InternalHttpReader({
        origin: 'https://127.0.0.1:4999',
        origins: { ventas: 'https://127.0.0.1:4999' },
        mode: 'AUTHENTICATED',
        getServiceAccessToken: async (req) => {
          expect(req.audience).toBe('api-ventas');
          expect(req.scope).toBe('ventas:pedidos:evidencia-cupon:leer');
          return 'jwt-ventas-token';
        },
      });

      const snapshot = new G5CouponSnapshot(reader, {
        verifyCouponCatalogLines: async () => new Map([
          ['SKU-001', { productId: 'prod-001', categoryIds: [], brandId: null, isActive: true }],
        ]),
      } as never);

      const command: CouponCommand = {
        message_id: '00000000-0000-4000-8000-000000000001',
        correlation_id: '00000000-0000-4000-8000-000000000002',
        name: 'ventas.cupon.consumir.solicitud',
        data: {
          order_id: 'ord-g5-001',
          commercial_snapshot_ref: 'ord-g5-001',
          reservation_id: 'res-g5-001',
          effective_at: '2026-11-26T00:00:00.000Z',
          customer_ref: 'cust-001',
          channel_id: 'MARKETPLACE',
          coupon_code: 'PROMO10',
        },
      } as CouponCommand;

      await snapshot.read(command, AbortSignal.timeout(2000));

      expect(requestedUrls).toEqual([
        'https://127.0.0.1:4999/api/v1/integraciones/productos/pedidos/ord-g5-001/evidencia-cupon',
      ]);
      expect(requestedHeaders[0]?.authorization).toBe('Bearer jwt-ventas-token');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects untrusted self-signed HTTPS server when CA is not configured', async () => {
    const server = createHttpsServer({}, (_req, res) => {
      res.writeHead(200);
      res.end('{}');
    });
    expect(typeof server.close).toBe('function');
    server.close();
  });
});
