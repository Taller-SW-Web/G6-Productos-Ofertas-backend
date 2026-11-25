import assert from 'node:assert/strict';
import test from 'node:test';
import { buildManifest } from '../../fixtures/h5/catalog-h5-fixture.mjs';
import { expectedCommercialProducts, validateCommercialCatalogSnapshot } from './catalog-pagination-integrity.mjs';
import { startCatalogPaginationFixtureServer } from './catalog-pagination.fixture-server.h5.mjs';

test('loopback fixture serves every commercial page and detail for the frozen eligible set', async () => {
  const manifest = buildManifest();
  const server = await startCatalogPaginationFixtureServer({ manifest });
  try {
    const channel = 'MARKETPLACE';
    const expected = expectedCommercialProducts(manifest, channel);
    const pageSize = manifest.pagination.page_size;
    const totalPages = Math.ceil(expected.length / pageSize);
    const pages = [];
    const detailsByProduct = {};
    for (let pageNumber = 1; pageNumber <= totalPages; pageNumber += 1) {
      const response = await fetch(`${server.baseUrl}/api/v1/productos?canal=${channel}&pagina=${pageNumber}&tamanio=${pageSize}&orden=NOMBRE_ASC`, { headers: { authorization: server.authorization } });
      assert.equal(response.status, 200);
      pages.push(await response.json());
    }
    for (const product of expected.filter(item => item.variants.some(variant => variant.eligible && variant.state === 'ACTIVA'))) {
      const response = await fetch(`${server.baseUrl}/api/v1/productos/${product.product_id}?canal=${channel}`, { headers: { authorization: server.authorization } });
      assert.equal(response.status, 200);
      detailsByProduct[product.product_id] = await response.json();
    }
    const result = validateCommercialCatalogSnapshot({ pages, detailsByProduct, manifest, channel });
    assert.equal(result.status, 'PASS');
    assert.deepEqual(result.findings, []);
  } finally {
    await server.close();
  }
});

test('loopback fixture rejects missing identity, invalid channel and channel-ineligible details', async () => {
  const server = await startCatalogPaginationFixtureServer();
  try {
    const noIdentity = await fetch(`${server.baseUrl}/api/v1/productos?canal=MARKETPLACE&pagina=1&tamanio=10`);
    assert.equal(noIdentity.status, 401);
    const invalidChannel = await fetch(`${server.baseUrl}/api/v1/productos?canal=INVALID&pagina=1&tamanio=10`, { headers: { authorization: server.authorization } });
    assert.equal(invalidChannel.status, 400);
    const ineligible = buildManifest().products.find(product => product.eligible_channels.length === 0);
    assert.ok(ineligible);
    const forbiddenDetail = await fetch(`${server.baseUrl}/api/v1/productos/${ineligible.product_id}?canal=MARKETPLACE`, { headers: { authorization: server.authorization } });
    assert.equal(forbiddenDetail.status, 404);
  } finally {
    await server.close();
  }
});
