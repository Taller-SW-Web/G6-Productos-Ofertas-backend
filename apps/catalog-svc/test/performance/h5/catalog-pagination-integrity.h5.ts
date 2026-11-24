import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildManifest } from '../../fixtures/h5/catalog-h5-fixture.mjs';
import { validateCatalogSnapshot } from './catalog-pagination-integrity.mjs';

const manifest = buildManifest();

function validSnapshot() {
  const expected = manifest.products
    .filter((product) => product.eligible && product.state === 'ACTIVO')
    .sort((left, right) =>
      left.product_id.localeCompare(right.product_id, 'en'),
    );
  const pageSize = manifest.pagination.page_size;
  const pages = [];
  for (let index = 0; index < expected.length; index += pageSize) {
    const items = expected
      .slice(index, index + pageSize)
      .map(({ product_id, sku_base }) => ({ product_id, sku_base }));
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
});
