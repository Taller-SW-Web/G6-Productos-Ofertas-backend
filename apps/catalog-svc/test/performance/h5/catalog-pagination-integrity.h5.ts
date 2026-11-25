import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildManifest } from '../../fixtures/h5/catalog-h5-fixture.mjs';
import {
  expectedCommercialProducts,
  validateCatalogSnapshot,
  validateCommercialCatalogSnapshot,
} from './catalog-pagination-integrity.mjs';

const manifest = buildManifest();

function validSnapshot() {
  const expected = manifest.products
    .filter((product) => product.eligible && product.state === 'ACTIVO')
    .sort(
      (left, right) =>
        left.nombre.localeCompare(right.nombre, 'es') ||
        left.product_id.localeCompare(right.product_id, 'en'),
    );
  const pageSize = manifest.pagination.page_size;
  const pages = [];
  for (let index = 0; index < expected.length; index += pageSize) {
    const items = expected
      .slice(index, index + pageSize)
      .map(({ product_id, nombre, sku_base }) => ({
        product_id,
        nombre,
        sku_base,
      }));
    pages.push({
      items,
      meta: {
        pagina: pages.length + 1,
        tamanio: pageSize,
        total: expected.length,
        totalPaginas: Math.ceil(expected.length / pageSize),
      },
    });
  }
  const variantsByProduct = Object.fromEntries(
    expected
      .filter((product) => product.variants.length > 0)
      .map((product) => [
        product.product_id,
        product.variants
          .filter((variant) => variant.eligible)
          .map(({ variant_id, sku }) => ({ variant_id, sku })),
      ]),
  );
  return { pages, variantsByProduct, manifest };
}

function validCommercialSnapshot(channel = 'MARKETPLACE') {
  const expected = expectedCommercialProducts(manifest, channel);
  const pageSize = manifest.pagination.page_size;
  const pages = [];
  for (let offset = 0; offset < expected.length; offset += pageSize) {
    pages.push({
      items: expected.slice(offset, offset + pageSize).map((product) => ({
        product_id: product.product_id,
        name: product.nombre,
        sku_base: product.variants.length ? null : product.sku_base,
        tiene_variantes: product.variants.length > 0,
      })),
      pagina: pages.length + 1,
      tamanio: pageSize,
      total: expected.length,
    });
  }
  const detailsByProduct = Object.fromEntries(
    expected
      .filter((product) =>
        product.variants.some(
          (variant) => variant.eligible && variant.state === 'ACTIVA',
        ),
      )
      .map((product) => [
        product.product_id,
        {
          product_id: product.product_id,
          variants: product.variants
            .filter((variant) => variant.eligible && variant.state === 'ACTIVA')
            .map(({ variant_id, sku }) => ({ variant_id, sku })),
        },
      ]),
  );
  return { pages, detailsByProduct, manifest, channel };
}

describe('PERF-01 manifest data-integrity oracle', () => {
  it('covers every eligible product and sellable SKU across stable pages', () => {
    const result = validateCatalogSnapshot(validSnapshot());
    expect(result).toMatchObject({
      status: 'PASS',
      productCount: 23,
      pages: 3,
    });
    expect(result.sellableSkuCount).toBe(
      manifest.expected.sellable_skus.length,
    );
  });

  it('enforces contract name and product identity ordering plus the complete name oracle', () => {
    const snapshot = validSnapshot();
    expect(manifest.pagination.stable_sort).toBe('nombre:asc,product_id:asc');
    snapshot.pages[0].items[0].nombre = 'nombre alterado';
    expect(validateCatalogSnapshot(snapshot).status).toBe('FAIL');
  });

  it.each([
    [
      'missing product',
      (snapshot) => {
        snapshot.pages[0].items.pop();
      },
    ],
    [
      'duplicate product',
      (snapshot) => {
        snapshot.pages[0].items[1].product_id =
          snapshot.pages[0].items[0].product_id;
      },
    ],
    [
      'ineligible product',
      (snapshot) => {
        snapshot.pages[0].items[0].product_id =
          manifest.expected.excluded_product_ids[0];
      },
    ],
    [
      'unstable order',
      (snapshot) => {
        [snapshot.pages[0].items[0], snapshot.pages[0].items[1]] = [
          snapshot.pages[0].items[1],
          snapshot.pages[0].items[0],
        ];
      },
    ],
    [
      'wrong sku_base',
      (snapshot) => {
        snapshot.pages[0].items[0].sku_base = 'POMA-H5-WRONG';
      },
    ],
    [
      'unexpected product',
      (snapshot) => {
        snapshot.pages[0].items[0].product_id =
          'ffffffff-ffff-4fff-8fff-ffffffffffff';
      },
    ],
    [
      'duplicate sku_base',
      (snapshot) => {
        snapshot.pages[0].items[1].sku_base =
          snapshot.pages[0].items[0].sku_base;
      },
    ],
    [
      'wrong pagination metadata',
      (snapshot) => {
        snapshot.pages[1].meta.pagina = 1;
      },
    ],
    [
      'missing variants',
      (snapshot) => {
        delete snapshot.variantsByProduct[
          manifest.products.find((product) => product.variants.length > 0)!
            .product_id
        ];
      },
    ],
    [
      'disabled variant',
      (snapshot) => {
        const product = manifest.products.find((item) =>
          item.variants.some((variant) => !variant.eligible),
        )!;
        snapshot.variantsByProduct[product.product_id].push({
          variant_id: product.variants.find((variant) => !variant.eligible)!
            .variant_id,
          sku: product.variants.find((variant) => !variant.eligible)!.sku,
        });
      },
    ],
    [
      'duplicate sku value',
      (snapshot) => {
        const product = manifest.products.find(
          (item) => item.variants.length > 1,
        )!;
        snapshot.variantsByProduct[product.product_id][1].sku =
          snapshot.variantsByProduct[product.product_id][0].sku;
      },
    ],
  ])('rejects %s without a PASS', (_name, mutate) => {
    const snapshot = structuredClone(validSnapshot());
    mutate(snapshot);
    expect(validateCatalogSnapshot(snapshot).status).toBe('FAIL');
  });

  it('reads the exact canonical fixture instead of a hand-copied list', async () => {
    const diskManifest = JSON.parse(
      await readFile(
        resolve('apps/catalog-svc/test/fixtures/h5/manifest.json'),
        'utf8',
      ),
    );
    expect(diskManifest).toEqual(manifest);
  });

  it('valida la proyección comercial por canal, detalle de variantes y SKU vendibles', () => {
    const marketplace = validateCommercialCatalogSnapshot(
      validCommercialSnapshot(),
    );
    expect(marketplace).toMatchObject({
      status: 'PASS',
      productCount:
        manifest.expected.commercial_product_ids_by_channel.MARKETPLACE.length,
    });
    for (const channel of ['CHATBOT', 'RETAIL', 'VENTAS']) {
      expect(
        validateCommercialCatalogSnapshot(validCommercialSnapshot(channel))
          .status,
      ).toBe('PASS');
    }
  });

  it('rechaza un canal no normativo y elementos excluidos de la página comercial', () => {
    expect(
      validateCommercialCatalogSnapshot({
        ...validCommercialSnapshot(),
        channel: 'INVALID',
      }).status,
    ).toBe('FAIL');
    const snapshot = structuredClone(validCommercialSnapshot());
    snapshot.pages[0].items[0].product_id =
      manifest.expected.excluded_product_ids[0];
    expect(validateCommercialCatalogSnapshot(snapshot).findings).toContain(
      'INELIGIBLE_OR_UNEXPECTED_PRODUCT',
    );
  });

  it.each([
    ['missing row', (snapshot) => snapshot.pages[0].items.pop()],
    [
      'duplicate row',
      (snapshot) => {
        snapshot.pages[0].items[1].product_id =
          snapshot.pages[0].items[0].product_id;
      },
    ],
    [
      'wrong order',
      (snapshot) => {
        [snapshot.pages[0].items[0], snapshot.pages[0].items[1]] = [
          snapshot.pages[0].items[1],
          snapshot.pages[0].items[0],
        ];
      },
    ],
    [
      'wrong SKU base',
      (snapshot) => {
        snapshot.pages[0].items[0].sku_base = 'POMA-H5-WRONG';
      },
    ],
    [
      'missing commercial variant',
      (snapshot) => {
        const id = Object.keys(snapshot.detailsByProduct)[0];
        snapshot.detailsByProduct[id].variants.pop();
      },
    ],
  ])('rechaza %s en el snapshot comercial', (_name, mutate) => {
    const snapshot = structuredClone(validCommercialSnapshot());
    mutate(snapshot);
    expect(validateCommercialCatalogSnapshot(snapshot).status).toBe('FAIL');
  });
});
