import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { PostgresCatalogRepository } from '../src/postgres-catalog.repository.js';
import { COMMERCIAL_ELIGIBILITY } from '../src/commercial-eligibility.js';
import { TaxonomyClient } from '../src/taxonomy.client.js';

describe('Catalog commercial boundary (isolated fixtures, not PostgreSQL evidence)', () => {
  let app: INestApplication;
  const product = {
    product_id: 'product-fixture',
    slug: 'simple-fixture',
    name: 'Simple',
    description: 'Fixture',
    categoria_id: 'cat',
    tipo_producto_id: 'type',
    marca_id: 'brand',
    tiene_variantes: false,
    sku_base: '0001',
    images: [],
    attributes: [],
    variants: [],
  };
  const repository = { listCandidates: vi.fn(), findCandidateBySlug: vi.fn() };
  async function start(approvedFixture = false) {
    const builder = Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PostgresCatalogRepository)
      .useValue(repository)
      .overrideProvider(TaxonomyClient)
      .useValue({
        brand: async () => ({
          marca_id: 'brand',
          name: 'Brand fixture',
          description: null,
          logo_url: null,
          country_code: null,
        }),
        category: async () => undefined,
      });
    if (approvedFixture)
      builder.overrideProvider(COMMERCIAL_ELIGIBILITY).useValue({
        resolve: async () => ({
          productIds: ['product-fixture'],
          variantIds: [],
        }),
      });
    app = (await builder.compile()).createNestApplication();
    await app.init();
  }
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(async () => {
    await app?.close();
  });
  it('fails closed by default before accessing candidates', async () => {
    await start();
    for (const path of [
      '/api/v1/productos?canal=MARKETPLACE',
      '/api/v1/productos/por-slug/simple-fixture?canal=MARKETPLACE',
    ]) {
      const response = await request(app.getHttpServer()).get(path).expect(503);
      expect(response.body.code).toBe('SERVICIO_NO_DISPONIBLE');
    }
    expect(repository.listCandidates).not.toHaveBeenCalled();
    expect(repository.findCandidateBySlug).not.toHaveBeenCalled();
  });
  it('returns a contract-shaped fixture page when the policy is supplied in test', async () => {
    await start(true);
    const { variants: _variants, ...summary } = product;
    repository.listCandidates.mockResolvedValue({
      items: [summary],
      pagina: 2,
      tamanio: 10,
      total: 11,
    });
    const response = await request(app.getHttpServer())
      .get('/api/v1/productos?canal=MARKETPLACE&pagina=2&tamanio=10')
      .expect(200);
    expect(response.body.items[0].sku_base).toBe('0001');
    expect(repository.listCandidates).toHaveBeenCalledWith(
      expect.objectContaining({ pagina: 2, tamanio: 10 }),
      { productIds: ['product-fixture'], variantIds: [] },
    );
  });
  it('composes detail through the Taxonomy boundary and preserves simple SKU', async () => {
    await start(true);
    repository.findCandidateBySlug.mockResolvedValue(product);
    const response = await request(app.getHttpServer())
      .get('/api/v1/productos/por-slug/simple-fixture?canal=MARKETPLACE')
      .expect(200);
    expect(response.body).toMatchObject({
      sku_base: '0001',
      variants: [],
      marca: { name: 'Brand fixture' },
    });
  });
  it('returns contractual 404 and correlation for absent/ineligible detail', async () => {
    await start(true);
    repository.findCandidateBySlug.mockResolvedValue(null);
    const correlation = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
    const response = await request(app.getHttpServer())
      .get('/api/v1/productos/por-slug/absent?canal=MARKETPLACE')
      .set('X-Correlation-Id', correlation)
      .expect(404);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    expect(response.body).toMatchObject({
      code: 'PRODUCTO_NO_ENCONTRADO',
      correlationId: correlation,
    });
  });
  it('rejects malformed input and never ignores a price filter', async () => {
    await start(true);
    await request(app.getHttpServer())
      .get('/api/v1/productos?canal=MARKETPLACE&tamanio=101')
      .expect(400);
    await request(app.getHttpServer())
      .get('/api/v1/productos?canal=MARKETPLACE&precioMin=1')
      .expect(503);
    expect(repository.listCandidates).not.toHaveBeenCalled();
  });
});
