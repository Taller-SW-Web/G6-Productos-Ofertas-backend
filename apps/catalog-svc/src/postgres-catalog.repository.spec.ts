import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Database } from './database.js';
import { PostgresCatalogRepository } from './postgres-catalog.repository.js';

// Driver de prueba aislado: valida SQL generado y mapping, NO acredita PostgreSQL.
describe('Catalog provider SQL and projections (isolated)', () => {
  const statements: { text: string; values: unknown[] }[] = [];
  let productWithVariants = false;
  const client = {
    release() {},
    async query(config: string | { text: string }, values: unknown[] = []) {
      const text = typeof config === 'string' ? config : config.text;
      statements.push({ text, values });
      if (text.includes('count(*)')) return { rows: [[1]] };
      if (text.includes('from "catalog"."products"'))
        return {
          rows: [
            [
              'product-fixture',
              'fixture',
              'Fixture',
              'Fixture description',
              'cat',
              'type',
              'brand',
              productWithVariants,
              '0001',
            ],
          ],
        };
      if (text.includes('from "catalog"."variants"'))
        return { rows: [['variant-fixture', '0002']] };
      if (text.includes('from "catalog"."product_images"'))
        return { rows: [['https://example.test/product.webp']] };
      if (text.includes('from "catalog"."variant_images"'))
        return { rows: [['https://example.test/variant.webp']] };
      if (text.includes('from "catalog"."product_attribute_values"'))
        return { rows: [['c1', 'Material', null, 'Cotton']] };
      if (text.includes('from "catalog"."variant_attribute_values"'))
        return {
          rows: [
            ['c2', 'Size', 'value-M', 'M', true],
            ['c3', 'Material', null, 'Cotton', false],
          ],
        };
      return { rows: [] };
    },
  };
  const pool = { ...client, connect: async () => client };
  const db = drizzle(pool as unknown as pg.Pool);
  const database = {
    read: <T>(read: (connection: typeof db) => Promise<T>) => read(db),
  };
  const repo = new PostgresCatalogRepository(database as Database);
  beforeEach(() => {
    statements.length = 0;
    productWithVariants = false;
  });
  it('parameterizes literal text and filters eligibility in COUNT before LIMIT/OFFSET', async () => {
    await repo.listCandidates(
      {
        canal: 'MARKETPLACE',
        q: "x%' OR true --",
        pagina: 2,
        tamanio: 10,
        orden: 'NOMBRE_DESC',
      },
      { productIds: ['product-fixture'], variantIds: ['variant-fixture'] },
    );
    const count = statements.find((s) => s.text.includes('count(*)'))!;
    expect(count.text).toContain('exists (SELECT');
    expect(count.text).not.toContain('OR true --');
    expect(count.values).toContain("%x\\%' OR true --%");
    expect(count.values).toContain('ACTIVO');
    expect(count.values).toContain('ACTIVA');
    expect(count.values).toContain('product-fixture');
    const page = statements.find((s) => s.text.includes('limit'))!;
    expect(page.text).toContain('"nombre" desc');
    expect(page.values.slice(-2)).toEqual([10, 10]);
    expect(statements[0].text).toContain('read only');
    expect(statements.at(-1)?.text).toBe('commit');
    expect(statements.every((s) => !s.text.includes('"taxonomy"'))).toBe(true);
  });
  it('composes simple/variant DTOs with exact identities and no administrative columns', async () => {
    const simple = await repo.findCandidateBySlug('fixture');
    expect(simple?.sku_base).toBe('0001');
    expect(simple?.variants).toEqual([]);
    productWithVariants = true;
    const detail = await repo.findCandidateBySlug('fixture', {
      productIds: ['product-fixture'],
      variantIds: ['variant-fixture'],
    });
    expect(detail?.variants).toEqual([
      {
        variant_id: 'variant-fixture',
        sku: '0002',
        identifying_attributes: [
          {
            caracteristica_id: 'c2',
            nombre: 'Size',
            valor_id: 'value-M',
            valor: 'M',
          },
        ],
        non_identifying_attributes: [
          {
            caracteristica_id: 'c3',
            nombre: 'Material',
            valor_id: null,
            valor: 'Cotton',
          },
        ],
        images: ['https://example.test/variant.webp'],
      },
    ]);
    expect(detail).not.toHaveProperty('estado');
    expect(detail?.attributes).toEqual([
      {
        caracteristica_id: 'c1',
        nombre: 'Material',
        valor_id: null,
        valor: 'Cotton',
      },
    ]);
  });
});
