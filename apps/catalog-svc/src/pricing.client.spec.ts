import { ServiceUnavailableException } from '@nestjs/common';
import { PricingClient } from './pricing.client.js';
import type { CatalogConfig } from './config.js';

const productId = '88888888-8888-4888-8888-888888888888';
const current = {
  product_id: productId,
  precio_regular: 69.9,
  precio_oferta: null,
  currency: 'PEN',
  channel_id: null,
  valid_from: '2026-01-01T00:00:00.000Z',
  valid_until: null,
  price_version: 1,
};

describe('PricingClient (mock HTTP responses)', () => {
  const fetchMock = vi.fn();
  const client = new PricingClient({
    pricingOrigin: 'http://pricing-svc:3002',
  } as CatalogConfig);

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('requests the private route, rejects redirects, and returns only validated current-price fields', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(current), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await expect(client.currentPrice(productId)).resolves.toEqual({
      precio_regular: 69.9,
      precio_oferta: null,
      currency: 'PEN',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      new URL(`http://pricing-svc:3002/api/v1/precios/productos/${productId}`),
      expect.objectContaining({ redirect: 'manual' }),
    );
  });

  it('treats a Pricing 404 as no price', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 404 }));
    await expect(client.currentPrice(productId)).resolves.toBeNull();
  });

  it.each([
    { ...current, product_id: 'wrong' },
    { ...current, precio_regular: 0 },
    { ...current, valid_from: '2999-01-01T00:00:00.000Z' },
    { ...current, valid_from: '2026-02-30T00:00:00.000Z' },
    { ...current, valid_until: '2000-01-01T00:00:00.000Z' },
    { ...current, channel_id: 'marketplace' },
  ])('fails closed for invalid Price responses', async (body) => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await expect(client.currentPrice(productId)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('maps Pricing network failures and redirects to 503 without details', async () => {
    fetchMock.mockRejectedValueOnce(new Error('private URL detail'));
    await expect(client.currentPrice(productId)).rejects.toMatchObject({
      status: 503,
      message: 'Servicio temporalmente no disponible',
    });
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 302 }));
    await expect(client.currentPrice(productId)).rejects.toMatchObject({
      status: 503,
    });
  });
});
