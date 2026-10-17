import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import {
  CatalogTokenRejected,
  CatalogTokenVerifier,
} from '../src/catalog-auth.js';
import { CatalogMutationService } from '../src/catalog-mutation.service.js';
import { CatalogQueryRepository } from '../src/catalog-query.repository.js';
import { CommercialService } from '../src/commercial.service.js';

describe('Catalog HTTP routes and security (isolated use-case fixtures)', () => {
  let app: INestApplication;
  const correlation = randomUUID();
  const variant = {
    variant_id: 'v',
    sku: '0000123',
    status: 'BORRADOR',
    identifying_attributes: [],
    non_identifying_attributes: [],
    images: [],
    physical_profile: null,
    catalog_version: 0,
  };
  const product = {
    product_id: 'p',
    slug: 'fixture',
    name: 'Fixture',
    categoria_id: 'cat',
    tipo_producto_id: 'type',
    marca_id: 'brand',
    tiene_variantes: false,
    status: 'BORRADOR',
    variants: [],
  };
  const mutations = {
    createProduct: vi.fn(async () => product),
    createVariant: vi.fn(async () => variant),
    update: vi.fn(async (_p: string, v?: string) => (v ? variant : product)),
    state: vi.fn(async (_p: string, v?: string) => (v ? variant : product)),
    retry: vi.fn(async () => ({
      operation_id: randomUUID(),
      status: 'ACCEPTED',
      correlation_id: correlation,
    })),
  };
  const queryRepository = {
    physicalData: vi.fn(async (skus: string[]) => ({
      productos: [],
      noEncontrados: skus,
    })),
    productPreparation: vi.fn(async () => ({
      product_id: 'p',
      tiene_variantes: false,
      pricing: { status: 'PENDING', manual_retry_allowed: false, code: null },
      inventario: {
        status: 'PENDING',
        manual_retry_allowed: false,
        code: null,
      },
      variantes: [],
    })),
    listVariants: vi.fn(async () => ({
      items: [variant],
      meta: { pagina: 1, tamanio: 20, total: 1, totalPaginas: 1 },
    })),
    findVariant: vi.fn(async () => variant),
  };
  const commercial = {
    list: vi.fn(async () => ({ items: [], pagina: 1, tamanio: 20, total: 0 })),
    detail: vi.fn(async () => ({
      product_id: product.product_id,
      slug: product.slug,
      name: product.name,
      categoria_id: product.categoria_id,
      tipo_producto_id: product.tipo_producto_id,
      marca_id: product.marca_id,
      tiene_variantes: product.tiene_variantes,
      variants: [],
      marca: { marca_id: 'brand', name: 'Brand' },
    })),
    productById: vi.fn(async () => ({
      product_id: product.product_id,
      slug: product.slug,
      name: product.name,
      categoria_id: product.categoria_id,
      tipo_producto_id: product.tipo_producto_id,
      marca_id: product.marca_id,
      tiene_variantes: product.tiene_variantes,
      variants: [],
      marca: { marca_id: 'brand', name: 'Brand' },
    })),
  };
  beforeAll(async () => {
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(CatalogMutationService)
      .useValue(mutations)
      .overrideProvider(CatalogQueryRepository)
      .useValue(queryRepository)
      .overrideProvider(CommercialService)
      .useValue(commercial)
      .overrideProvider(CatalogTokenVerifier)
      .useValue({
        verify: async (token: string) => {
          if (token === 'manager')
            return {
              kind: 'user',
              subject: randomUUID(),
              roles: ['GESTOR_COMERCIAL'],
            };
          if (token === 'viewer')
            return { kind: 'user', subject: randomUUID(), roles: [] };
          const clients: Record<string, string> = {
            channel: 'modulo-marketplace',
            dispatch: 'modulo-despacho',
            retail: 'modulo-retail',
          };
          if (clients[token])
            return {
              kind: 'service',
              subject: clients[token],
              audiences: ['api-productos'],
              scopes:
                token === 'dispatch'
                  ? ['productos:fisicos:leer']
                  : ['catalogo:leer'],
            };
          throw new CatalogTokenRejected();
        },
      })
      .compile();
    app = module.createNestApplication();
    await app.init();
  });
  afterAll(async () => {
    await app?.close();
  });
  beforeEach(() => vi.clearAllMocks());
  const writes = [
    ['post', '/productos', {}, 201, 'createProduct'],
    ['patch', '/productos/p', {}, 200, 'update'],
    ['post', '/productos/p/activar', {}, 200, 'state'],
    ['post', '/productos/p/desactivar', {}, 200, 'state'],
    ['post', '/productos/p/reactivar', {}, 200, 'state'],
    [
      'post',
      '/productos/p/preparacion/reintentar',
      { dependencia: 'PRICING' },
      202,
      'retry',
    ],
    ['post', '/productos/p/variantes', {}, 201, 'createVariant'],
    ['patch', '/productos/p/variantes/v', {}, 200, 'update'],
    ['post', '/productos/p/variantes/v/activar', {}, 200, 'state'],
    ['post', '/productos/p/variantes/v/desactivar', {}, 200, 'state'],
    ['post', '/productos/p/variantes/v/reactivar', {}, 200, 'state'],
    [
      'post',
      '/productos/p/variantes/v/preparacion/reintentar',
      {},
      202,
      'retry',
    ],
  ] as const;
  it.each(writes)(
    'registers and authorizes %s %s with contractual success status',
    async (method, path, body, status, useCase) => {
      const response = await request(app.getHttpServer())
        [method]('/api/v1' + path)
        .set('Authorization', 'Bearer manager')
        .set('X-Correlation-Id', correlation)
        .send(body)
        .expect(status);
      expect(mutations[useCase]).toHaveBeenCalledOnce();
      if (status === 202)
        expect(response.body).toMatchObject({
          status: 'ACCEPTED',
          correlation_id: correlation,
        });
      else
        expect(response.body).toHaveProperty(
          path.includes('/variantes') ? 'variant_id' : 'product_id',
        );
    },
  );
  it.each(writes)(
    'rejects unauthenticated and unauthorized callers of %s %s',
    async (method, path, body, _status, useCase) => {
      const missing = await request(app.getHttpServer())
        [method]('/api/v1' + path)
        .send(body)
        .expect(401);
      expect(missing.body.code).toBe('TOKEN_INVALIDO');
      for (const token of ['viewer', 'channel']) {
        const response = await request(app.getHttpServer())
          [method]('/api/v1' + path)
          .set('Authorization', 'Bearer ' + token)
          .send(body)
          .expect(403);
        expect(response.body.code).toBe('SCOPE_INSUFICIENTE');
      }
      expect(mutations[useCase]).not.toHaveBeenCalled();
    },
  );
  it('exercises all eight read operationIds and preserves the blocked barcode boundary', async () => {
    for (const path of [
      '/productos?canal=MARKETPLACE',
      '/productos/p?canal=MARKETPLACE',
      '/productos/por-slug/fixture?canal=MARKETPLACE',
    ])
      await request(app.getHttpServer())
        .get('/api/v1' + path)
        .set('Authorization', 'Bearer channel')
        .expect(200);
    for (const path of [
      '/productos/p/preparacion',
      '/productos/p/variantes',
      '/productos/p/variantes/v',
    ])
      await request(app.getHttpServer())
        .get('/api/v1' + path)
        .set('Authorization', 'Bearer manager')
        .expect(200);
    const physical = await request(app.getHttpServer())
      .post('/api/v1/productos/datos-fisicos/consulta')
      .set('Authorization', 'Bearer dispatch')
      .send({ skus: ['0000123'] })
      .expect(200);
    expect(physical.body).toEqual({
      productos: [],
      noEncontrados: ['0000123'],
    });
    const barcode = await request(app.getHttpServer())
      .post('/api/v1/productos/codigos-barras/resolver')
      .set('Authorization', 'Bearer retail')
      .send({ codigo_barras: '0000123' })
      .expect(503);
    expect(barcode.body.code).toBe('SERVICIO_NO_DISPONIBLE');
  });
  it('denies wrong client/scope and rejects malformed product detail query parameters', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/productos/datos-fisicos/consulta')
      .set('Authorization', 'Bearer channel')
      .send({ skus: ['000'] })
      .expect(403);
    await request(app.getHttpServer())
      .get('/api/v1/productos/p/preparacion')
      .set('Authorization', 'Bearer viewer')
      .expect(403);
    await request(app.getHttpServer())
      .get('/api/v1/productos/p?canal=MARKETPLACE&invented=1')
      .set('Authorization', 'Bearer channel')
      .expect(400);
  });
});
