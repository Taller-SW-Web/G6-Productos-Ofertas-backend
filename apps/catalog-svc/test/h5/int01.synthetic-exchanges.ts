import { describe, expect, it } from 'vitest';
import { buildManifest } from '../fixtures/h5/catalog-h5-fixture.mjs';
import {
  classifyPreparationResponse,
  CONTRACT_OPERATIONS,
  CONTRACT_VERSION,
  DOCS_SHA,
  replayContractExchange,
} from './int01-contract-oracles.mjs';

const manifest = buildManifest();
const variantProduct = manifest.products.find(
  (product) => product.sku_base === 'POMA-H5-VARIABLE-0002',
)!;
const activeVariants = variantProduct.variants.filter(
  (variant) => variant.eligible && variant.state === 'ACTIVA',
);
const simpleProduct = manifest.products.find(
  (product) => product.sku_base === 'POMA-H5-SIMPLE-0001',
)!;
const simpleSummary = (
  product: typeof simpleProduct,
  overrides: Record<string, unknown> = {},
) => ({
  product_id: product.product_id,
  slug: product.product_id,
  name: product.nombre,
  description: null,
  categoria_id: 'CAT-H5',
  tipo_producto_id: 'TYPE-H5',
  marca_id: 'BRAND-H5',
  tiene_variantes: false,
  sku_base: product.sku_base,
  status: 'BORRADOR',
  images: [],
  attributes: [],
  catalog_version: 1,
  pricing_preparado: false,
  inventario_inicializado: false,
  variants: [],
  ...overrides,
});
const preparation = (
  productId: string,
  status: 'PENDING' | 'COMPLETED' | 'REJECTED',
) => ({
  product_id: productId,
  tiene_variantes: false,
  pricing: { status, manual_retry_allowed: status === 'REJECTED' },
  inventario: { status, manual_retry_allowed: status === 'REJECTED' },
  variantes: [],
});
const priceResponse = (
  sku: string,
  channelId: string | null,
  price: number,
) => ({
  sku,
  precio_regular: price,
  precio_oferta: null,
  currency: 'PEN',
  channel_id: channelId,
  valid_from: '2026-01-01T00:00:00Z',
  valid_until: null,
  price_version: 1,
  vigencia_id: '00000000-0000-4000-8000-000000000003',
  origen: channelId ? 'SKU_OVERRIDE' : 'PRODUCTO',
});
const replay = (
  operationId: string,
  method: string,
  path: string,
  status: number,
  body: Record<string, unknown>,
  requestBody?: Record<string, unknown>,
) =>
  replayContractExchange({
    operationId,
    request: { method, path, ...(requestBody ? { body: requestBody } : {}) },
    response: { status, body },
  });
const problem = (status: number, code: string) => ({
  status,
  code,
  title: 'Resultado sintético contractual',
});

describe('INT-01 intercambios sintéticos L0 contra esquemas de OpenAPI rc.3', () => {
  it('valida el listado comercial paginado y el detalle de productos simples y con variantes', () => {
    const expected = manifest.products
      .filter((product) => product.eligible_channels.includes('MARKETPLACE'))
      .sort(
        (a, b) =>
          a.nombre.localeCompare(b.nombre, 'es') ||
          a.product_id.localeCompare(b.product_id, 'en'),
      );
    const items = expected.map((product) => ({
      product_id: product.product_id,
      slug: product.product_id,
      name: product.nombre,
      description: null,
      categoria_id: 'CAT-H5',
      tipo_producto_id: 'TYPE-H5',
      marca_id: 'BRAND-H5',
      tiene_variantes: product.variants.length > 0,
      sku_base: product.variants.length > 0 ? null : product.sku_base,
      images: [],
      attributes: [],
    }));
    const list = replay(
      'catalog-commercial-list',
      'GET',
      '/productos?canal=MARKETPLACE&pagina=1&tamanio=25&orden=NOMBRE_ASC',
      200,
      { items, pagina: 1, tamanio: 25, total: expected.length },
    );
    expect(list.body.items).toHaveLength(expected.length);
    expect(
      (list.body.items as Array<{ product_id: string }>).map(
        (item) => item.product_id,
      ),
    ).toEqual(expected.map((product) => product.product_id));
    expect(() =>
      replay(
        'catalog-commercial-list',
        'GET',
        '/productos?canal=MARKETPLACE&pagina=1&tamanio=25',
        200,
        { items, pagina: 2, tamanio: 25, total: expected.length },
      ),
    ).toThrow('INT01_COMMERCIAL_PAGE_METADATA_INVALID');
    expect(() =>
      replay(
        'catalog-commercial-list',
        'GET',
        '/productos?pagina=1&tamanio=25',
        200,
        { items, pagina: 1, tamanio: 25, total: expected.length },
      ),
    ).toThrow('INT01_REQUIRED_QUERY_MISSING');
    expect(items.some((item) => item.tiene_variantes)).toBe(true);
    expect(
      items.some(
        (item) =>
          !item.tiene_variantes && item.sku_base === simpleProduct.sku_base,
      ),
    ).toBe(true);

    const variants = activeVariants.map((variant) => ({
      variant_id: variant.variant_id,
      sku: variant.sku,
      identifying_attributes: [],
      non_identifying_attributes: [],
      images: [],
    }));
    const detail = replay(
      'catalog-commercial-detail',
      'GET',
      `/productos/${variantProduct.product_id}?canal=MARKETPLACE`,
      200,
      {
        ...items.find((item) => item.product_id === variantProduct.product_id)!,
        marca: {
          marca_id: 'BRAND-H5',
          name: 'Marca sintética',
          status: 'ACTIVA',
        },
        variants,
      },
    );
    expect(detail.body.product_id).toBe(variantProduct.product_id);
    expect(
      (detail.body.variants as Array<{ sku: string }>).map((item) => item.sku),
    ).toEqual(activeVariants.map((item) => item.sku));
    expect(CONTRACT_VERSION).toBe('0.7.0-rc.3');
    expect(DOCS_SHA).toBe('c9e1e5c217616d28229fccf5315fb97a1ae061a9');
  });

  it('valida creación, edición con versionado, inmutabilidad de SKU y activación condicionada', () => {
    const productId = simpleProduct.product_id;
    const createBody = {
      nombre: 'Producto H5 sintético',
      descripcion: 'Producto contractual',
      categoriaId: 'CAT-H5',
      tipoProductoId: 'TYPE-H5',
      marcaId: 'BRAND-H5',
      precioBaseInicial: 129.9,
      skuBase: 'POMA-H5-CREATED-0001',
      tieneVariantes: false,
    };
    const created = replay(
      'catalog-product-create',
      'POST',
      '/productos',
      201,
      simpleSummary(simpleProduct, {
        name: createBody.nombre,
        sku_base: createBody.skuBase,
      }),
      createBody,
    );
    expect(created.body).toMatchObject({
      status: 'BORRADOR',
      sku_base: createBody.skuBase,
      catalog_version: 1,
    });

    const edited = replay(
      'catalog-product-edit',
      'PATCH',
      `/productos/${productId}`,
      200,
      simpleSummary(simpleProduct, {
        catalog_version: 2,
        description: 'Edición sintética',
      }),
      { descripcion: 'Edición sintética', catalogVersion: 1 },
    );
    expect(edited.body.catalog_version).toBe(2);
    expect(edited.body.sku_base).toBe(simpleProduct.sku_base);
    const immutableSku = replay(
      'catalog-product-edit',
      'PATCH',
      `/productos/${productId}`,
      409,
      problem(409, 'CAMBIO_ESTRUCTURAL_NO_PERMITIDO'),
      { skuBase: 'POMA-H5-RECODED-0001', catalogVersion: 2 },
    );
    expect(immutableSku.body.code).toBe('CAMBIO_ESTRUCTURAL_NO_PERMITIDO');
    const staleVersion = replay(
      'catalog-product-edit',
      'PATCH',
      `/productos/${productId}`,
      409,
      problem(409, 'VERSION_CONFLICT'),
      { descripcion: 'Conflicto sintético', catalogVersion: 1 },
    );
    expect(staleVersion.body.code).toBe('VERSION_CONFLICT');

    const pending = replay(
      'catalog-preparation-read',
      'GET',
      `/productos/${productId}/preparacion`,
      200,
      preparation(productId, 'PENDING'),
    );
    expect(
      classifyPreparationResponse(
        pending.status,
        pending.body,
        'catalog-preparation-read',
      ),
    ).toEqual({ state: 'PENDING', terminal: false });
    expect(
      replay(
        'catalog-product-activate',
        'POST',
        `/productos/${productId}/activar`,
        422,
        problem(422, 'DATOS_INCOMPLETOS'),
      ).body.code,
    ).toBe('DATOS_INCOMPLETOS');
    const complete = replay(
      'catalog-preparation-read',
      'GET',
      `/productos/${productId}/preparacion`,
      200,
      preparation(productId, 'COMPLETED'),
    );
    expect(
      classifyPreparationResponse(
        complete.status,
        complete.body,
        'catalog-preparation-read',
      ),
    ).toEqual({ state: 'COMPLETED', terminal: true });
    expect(
      replay(
        'catalog-product-activate',
        'POST',
        `/productos/${productId}/activar`,
        200,
        simpleSummary(simpleProduct, {
          status: 'ACTIVO',
          catalog_version: 3,
          pricing_preparado: true,
          inventario_inicializado: true,
        }),
      ).body,
    ).toMatchObject({ status: 'ACTIVO', catalog_version: 3 });
  });

  it('resuelve precio específico y fallback global, y distingue ausencia y precio inválido', () => {
    const specific = manifest.pricing.find(
      (item) => item.channel_id === 'MARKETPLACE',
    )!;
    const global = manifest.pricing.find(
      (item) =>
        item.sku === 'POMA-H5-VAR-BLUE-M-0002' && item.channel_id === null,
    )!;
    const specificRead = replay(
      'pricing-effective-read',
      'GET',
      `/precios/skus/${specific.sku}?canal=MARKETPLACE`,
      200,
      priceResponse(specific.sku, 'MARKETPLACE', specific.amount_minor / 100),
    );
    const globalFallback = replay(
      'pricing-effective-read',
      'GET',
      `/precios/skus/${global.sku}?canal=MARKETPLACE`,
      200,
      priceResponse(global.sku, null, global.amount_minor / 100),
    );
    expect(specificRead.body).toMatchObject({
      channel_id: 'MARKETPLACE',
      currency: 'PEN',
    });
    expect(globalFallback.body).toMatchObject({
      channel_id: null,
      currency: 'PEN',
    });
    expect(
      replay(
        'pricing-effective-read',
        'GET',
        '/precios/skus/POMA-H5-NO-PRICE-0005?canal=MARKETPLACE',
        404,
        problem(404, 'PRECIO_NO_ENCONTRADO'),
      ).body.code,
    ).toBe('PRECIO_NO_ENCONTRADO');
    const invalidPrice = replay(
      'pricing-update',
      'PATCH',
      `/precios/skus/${specific.sku}`,
      422,
      problem(422, 'PRECIO_INVALIDO'),
      {
        precioRegular: -1,
        accionPrecioOferta: 'CONSERVAR',
        moneda: 'PEN',
        motivoCambio: 'Valor negativo sintético',
        priceVersion: 1,
      },
    );
    expect(invalidPrice.body.code).toBe('PRECIO_INVALIDO');
    expect(() =>
      replay(
        'pricing-effective-read',
        'GET',
        `/precios/skus/${specific.sku}?canal=MARKETPLACE`,
        200,
        priceResponse(specific.sku, 'MARKETPLACE', -1),
      ),
    ).toThrow('INT01_PRICE_RESPONSE_INVALID');
  });

  it('representa ausencia de saldo como lista vacía y rechaza saldos negativos de un proveedor', () => {
    const absent = replay(
      'inventory-availability-read',
      'GET',
      '/inventario/disponibilidad?skus=POMA-H5-NO-STOCK-0006&location_id=LOC-H5',
      200,
      { items: [] },
    );
    expect(absent.body.items).toEqual([]);
    expect(
      manifest.inventory.find((item) => item.sku === 'POMA-H5-NO-STOCK-0006'),
    ).toBeUndefined();
    expect(() =>
      replay(
        'inventory-availability-read',
        'GET',
        '/inventario/disponibilidad?skus=POMA-H5-NO-STOCK-0006',
        200,
        {
          items: [
            {
              sku: 'POMA-H5-NO-STOCK-0006',
              location_id: 'LOC-H5',
              on_hand: 1,
              reserved: 0,
              blocked: 0,
              available: -1,
              status: 'AGOTADO',
            },
          ],
        },
      ),
    ).toThrow('INT01_INVENTORY_NEGATIVE_BALANCE');
    // OpenAPI rc.3 exposes authoritative reads, not an H5 stock-write operation. A domain seeder must assert
    // server-side rejection of negative stock when that owner capability is available; this oracle never writes.
  });

  it('rechaza precio de creación no positivo y verifica método, ruta y body obligatorios', () => {
    const invalidCreate = replay(
      'catalog-product-create',
      'POST',
      '/productos',
      400,
      problem(400, 'VALIDACION'),
      {
        nombre: 'Producto inválido',
        descripcion: 'Precio no permitido',
        categoriaId: 'CAT-H5',
        tipoProductoId: 'TYPE-H5',
        marcaId: 'BRAND-H5',
        precioBaseInicial: 0,
        skuBase: 'POMA-H5-INVALID-PRICE',
        tieneVariantes: false,
      },
    );
    expect(invalidCreate.body.code).toBe('VALIDACION');
    expect(() =>
      replay(
        'catalog-product-create',
        'POST',
        '/productos',
        400,
        problem(400, 'VALIDACION'),
      ),
    ).toThrow('INT01_REQUEST_BODY_REQUIRED');
    expect(() =>
      replay(
        'catalog-commercial-list',
        'POST',
        '/productos?canal=MARKETPLACE&pagina=1&tamanio=10',
        405,
        problem(405, 'METODO_NO_PERMITIDO'),
      ),
    ).toThrow('INT01_REQUEST_METHOD_MISMATCH');
    expect(() =>
      replay(
        'catalog-commercial-list',
        'GET',
        '/api/v1/productos?canal=MARKETPLACE&pagina=1&tamanio=10',
        200,
        { items: [], pagina: 1, tamanio: 10, total: 0 },
      ),
    ).toThrow('INT01_REQUEST_PATH_MISMATCH');
  });

  it('mantiene distintos proveedor caído, scope ausente, identidad ausente y aislamiento de autorización', () => {
    const outage = replay(
      'pricing-effective-read',
      'GET',
      '/precios/skus/POMA-H5-SIMPLE-0001?canal=MARKETPLACE',
      503,
      problem(503, 'SERVICIO_NO_DISPONIBLE'),
    );
    const missingScope = replay(
      'catalog-commercial-list',
      'GET',
      '/productos?canal=MARKETPLACE&pagina=1&tamanio=10',
      403,
      problem(403, 'SCOPE_INSUFICIENTE'),
    );
    const missingIdentity = replay(
      'catalog-commercial-list',
      'GET',
      '/productos?canal=MARKETPLACE&pagina=1&tamanio=10',
      401,
      problem(401, 'TOKEN_INVALIDO'),
    );
    expect(outage.body.code).toBe('SERVICIO_NO_DISPONIBLE');
    expect(missingScope.body.code).toBe('SCOPE_INSUFICIENTE');
    expect(missingIdentity.body.code).toBe('TOKEN_INVALIDO');
    for (const status of [401, 403, 404, 409, 503]) {
      expect(() =>
        classifyPreparationResponse(
          status,
          preparation(simpleProduct.product_id, 'COMPLETED'),
          'catalog-preparation-read',
        ),
      ).toThrow('INT01_PREPARATION_HTTP_STATUS_INVALID');
    }
    const rejected = replay(
      'catalog-preparation-read',
      'GET',
      `/productos/${simpleProduct.product_id}/preparacion`,
      200,
      preparation(simpleProduct.product_id, 'REJECTED'),
    );
    expect(
      classifyPreparationResponse(
        rejected.status,
        rejected.body,
        'catalog-preparation-read',
      ),
    ).toEqual({ state: 'REJECTED', terminal: true });
    expect(
      CONTRACT_OPERATIONS.some((operation) =>
        /cancel/i.test(`${operation.id} ${operation.path}`),
      ),
    ).toBe(false);
  });
});
