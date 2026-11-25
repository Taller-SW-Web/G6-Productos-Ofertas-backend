import { createEnvironmentFixture } from '../../../test/support/environment.js';
import {
  PromotionsConfigService,
  validatePromotionsConfiguration,
} from '../config/promotions-config.js';
import {
  commercialProvider,
  adminReferenceProvider,
  unavailableServiceTokens,
} from './integration-providers.js';
import { HttpCommercialContext } from './commercial-http.js';
import { HttpAdminReferences } from './admin-references-http.js';
import {
  blockedCommercialContext,
  CommercialDependencyError,
} from '../../domain/commercial-context.js';
import { blockedAdminReferences } from '../../domain/admin-references.js';

describe('Configured integration providers', () => {
  const fixture = createEnvironmentFixture();
  afterAll(() => fixture.cleanup());
  it('keeps each missing integration explicit rather than returning empty facts', () => {
    const config = new PromotionsConfigService(
      validatePromotionsConfiguration(fixture.environment),
    );
    expect(commercialProvider(config, unavailableServiceTokens)).toBe(
      blockedCommercialContext,
    );
    expect(adminReferenceProvider(config, unavailableServiceTokens)).toBe(
      blockedAdminReferences,
    );
  });
  it('wires concrete clients when their own required URLs are present', () => {
    const config = new PromotionsConfigService(
      validatePromotionsConfiguration({
        ...fixture.environment,
        GATEWAY_CATALOG_SVC_URL: 'http://catalog-svc:3001',
        GATEWAY_PRICING_SVC_URL: 'http://pricing-svc:3002',
        GATEWAY_INVENTORY_SVC_URL: 'http://inventory-svc:3005',
        GATEWAY_TAXONOMY_SVC_URL: 'http://taxonomy-svc:3006',
      }),
    );
    expect(commercialProvider(config, unavailableServiceTokens)).toBeInstanceOf(
      HttpCommercialContext,
    );
    expect(
      adminReferenceProvider(config, unavailableServiceTokens),
    ).toBeInstanceOf(HttpAdminReferences);
  });

  it('keeps Catalog and Pricing authenticated when the inbound evaluation is public', async () => {
    const config = new PromotionsConfigService(
      validatePromotionsConfiguration({
        ...fixture.environment,
        G6_SECURITY_MODE: 'PUBLIC_READ_ONLY',
        PROMOTIONS_PUBLIC_OPERATION_IDS: 'evaluarPromociones',
        GATEWAY_CATALOG_SVC_URL: 'http://catalog-svc:3001',
        GATEWAY_PRICING_SVC_URL: 'http://pricing-svc:3002',
        GATEWAY_INVENTORY_SVC_URL: 'http://inventory-svc:3005',
      }),
    );
    const at = '2026-11-24T23:00:00Z';
    const tokenRequests: Array<{
      operationId: string;
      audience: string;
      scope: string;
    }> = [];
    const responses = [
      {
        sku: 'S-P',
        productId: 'P',
        isVariant: false,
        active: true,
        eligible: true,
      },
      {
        product_id: 'P',
        slug: 'p',
        name: 'P',
        tipo_producto_id: 'TYPE',
        marca_id: 'BRAND',
        categoria_id: 'CAT',
        marca: { marca_id: 'BRAND', name: 'Brand' },
        tiene_variantes: false,
        sku_base: 'S-P',
        variants: [],
      },
      {
        sku: 'S-P',
        precio_regular: 249.9,
        precio_oferta: null,
        currency: 'PEN',
        channel_id: null,
        valid_from: '2026-10-01T05:00:00Z',
        valid_until: null,
        price_version: 1,
        vigencia_id: 'PRICE-VERSION',
        origen: 'PRODUCTO',
      },
    ];
    const fetcher = vi.fn(
      async (input: URL | RequestInfo, init?: RequestInit) => {
        const url = new URL(String(input));
        expect(new Headers(init?.headers).get('authorization')).toBe(
          'Bearer synthetic-service-token',
        );
        expect(new Headers(init?.headers).get('x-correlation-id')).toMatch(
          /^[0-9a-f-]{36}$/i,
        );
        expect(url.pathname).toMatch(
          /^\/api\/v1\/(productos\/skus\/S-P\/contexto|productos\/P|precios\/skus\/S-P)$/,
        );
        return Response.json(responses.shift());
      },
    );
    vi.stubGlobal('fetch', fetcher);
    try {
      const commercial = commercialProvider(config, async (request) => {
        tokenRequests.push(request);
        return 'synthetic-service-token';
      });
      await expect(
        commercial.basket(
          { channel_id: 'CHATBOT', lines: [{ sku: 'S-P', quantity: 1 }] },
          at,
        ),
      ).resolves.toMatchObject({
        lines: [
          {
            sku: 'S-P',
            productId: 'P',
            regular: '249.9',
            offer: null,
            currency: 'PEN',
          },
        ],
      });
      expect(fetcher).toHaveBeenCalledTimes(3);
      expect(tokenRequests).toEqual([
        {
          operationId: 'obtenerContextoSku',
          audience: 'api-productos',
          scope: 'catalogo:leer',
        },
        {
          operationId: 'obtenerProducto',
          audience: 'api-productos',
          scope: 'catalogo:leer',
        },
        {
          operationId: 'obtenerPrecioSku',
          audience: 'api-productos',
          scope: 'precios:leer',
        },
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('fails closed without making an anonymous dependency call when its internal token is missing', async () => {
    const config = new PromotionsConfigService(
      validatePromotionsConfiguration({
        ...fixture.environment,
        G6_SECURITY_MODE: 'PUBLIC_READ_ONLY',
        PROMOTIONS_PUBLIC_OPERATION_IDS: 'evaluarPromociones',
        GATEWAY_CATALOG_SVC_URL: 'http://catalog-svc:3001',
        GATEWAY_PRICING_SVC_URL: 'http://pricing-svc:3002',
        GATEWAY_INVENTORY_SVC_URL: 'http://inventory-svc:3005',
      }),
    );
    const fetcher = vi.fn();
    const tokens = vi.fn(async () => null);
    vi.stubGlobal('fetch', fetcher);
    try {
      const commercial = commercialProvider(config, tokens);
      await expect(
        commercial.basket(
          { channel_id: 'CHATBOT', lines: [{ sku: 'S-P', quantity: 1 }] },
          '2026-11-24T23:00:00Z',
        ),
      ).rejects.toBeInstanceOf(CommercialDependencyError);
      expect(tokens).toHaveBeenCalledTimes(1);
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps administrative Catalog reads authenticated with their own technical token', async () => {
    const config = new PromotionsConfigService(
      validatePromotionsConfiguration({
        ...fixture.environment,
        G6_SECURITY_MODE: 'PUBLIC_READ_ONLY',
        PROMOTIONS_PUBLIC_OPERATION_IDS: 'evaluarPromociones',
        GATEWAY_CATALOG_SVC_URL: 'http://catalog-svc:3001',
        GATEWAY_TAXONOMY_SVC_URL: 'http://taxonomy-svc:3006',
      }),
    );
    const tokenRequests: unknown[] = [];
    const observed: Array<{ url: string; authorization: string | null }> = [];
    const fetcher = vi.fn(
      async (input: URL | RequestInfo, init?: RequestInit) => {
        const url = new URL(String(input));
        observed.push({
          url: url.pathname + url.search,
          authorization: new Headers(init?.headers).get('authorization'),
        });
        return Response.json({
          product_id: 'P',
          slug: 'p',
          name: 'P',
          categoria_id: 'C',
          tipo_producto_id: 'T',
          marca_id: 'M',
          tiene_variantes: false,
          marca: { marca_id: 'M', name: 'Marca' },
          variants: [],
        });
      },
    );
    vi.stubGlobal('fetch', fetcher);
    try {
      const provider = adminReferenceProvider(config, async (request) => {
        tokenRequests.push(request);
        return 'synthetic-admin-token';
      });
      await expect(
        provider.verify(
          { products: ['P'], skus: [], categories: [] },
          new AbortController().signal,
        ),
      ).resolves.toMatchObject({ products: new Set(['P']) });
      expect(tokenRequests).toEqual([
        {
          operationId: 'obtenerProducto',
          audience: 'api-productos',
          scope: 'catalogo:leer',
        },
      ]);
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(observed).toEqual([
        {
          url: '/api/v1/productos/P?canal=MARKETPLACE',
          authorization: 'Bearer synthetic-admin-token',
        },
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('fails closed for administrative reads when its technical token is missing', async () => {
    const config = new PromotionsConfigService(
      validatePromotionsConfiguration({
        ...fixture.environment,
        G6_SECURITY_MODE: 'PUBLIC_READ_ONLY',
        PROMOTIONS_PUBLIC_OPERATION_IDS: 'evaluarPromociones',
        GATEWAY_CATALOG_SVC_URL: 'http://catalog-svc:3001',
        GATEWAY_TAXONOMY_SVC_URL: 'http://taxonomy-svc:3006',
      }),
    );
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    try {
      const provider = adminReferenceProvider(config, async () => null);
      await expect(
        provider.verify(
          { products: ['P'], skus: [], categories: [] },
          new AbortController().signal,
        ),
      ).rejects.toBeInstanceOf(CommercialDependencyError);
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
