import { PgDialect } from 'drizzle-orm/pg-core';
import { PostgresCommercialEligibility } from './postgres-commercial-eligibility.js';
import type { Database } from './database.js';

describe('PostgresCommercialEligibility', () => {
  function policy(rows: unknown[], failure?: unknown) {
    const execute = vi.fn(async () => {
      if (failure) throw failure;
      return { rows };
    });
    const read = vi.fn(async (work: (db: never) => Promise<unknown>) =>
      work({ execute } as never),
    );
    return {
      instance: new PostgresCommercialEligibility({ read } as Database),
      execute,
      read,
    };
  }

  it('returns an empty selection when the table has no enabled rows', async () => {
    const { instance, execute } = policy([]);

    await expect(instance.resolve('MARKETPLACE')).resolves.toEqual({
      productIds: [],
      variantIds: [],
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('deduplicates eligible simple products and variant parents', async () => {
    const { instance } = policy([
      { product_id: 'simple', variant_id: null },
      { product_id: 'parent', variant_id: 'variant-a' },
      { product_id: 'parent', variant_id: 'variant-b' },
      { product_id: 'parent', variant_id: 'variant-a' },
    ]);

    await expect(instance.resolve('MARKETPLACE')).resolves.toEqual({
      productIds: ['simple', 'parent'],
      variantIds: ['variant-a', 'variant-b'],
    });
  });

  it('uses one parameterized SELECT for the requested channel and status rules', async () => {
    const { instance, execute } = policy([]);

    await instance.resolve('MARKETPLACE');

    const [query] = execute.mock.calls[0] ?? [];
    const compiled = new PgDialect().sqlToQuery(query as never);
    expect(compiled.sql).toContain('UNION ALL');
    expect(compiled.sql).toContain('catalog.sku_channel_eligibility');
    expect(compiled.sql).toContain("p.estado = 'ACTIVO'");
    expect(compiled.sql).toContain("v.estado = 'ACTIVA'");
    expect(compiled.sql).toContain('p.tiene_variantes = false');
    expect(compiled.sql).toContain('p.tiene_variantes = true');
    expect(compiled.params).toEqual(['MARKETPLACE', 'MARKETPLACE']);
  });

  it.each([
    ['missing candidate table', new Error('relation does not exist')],
    ['typed Poma persistence failure', new Error('persistence failure')],
    ['insufficient privileges', new Error('permission denied')],
  ])('fails closed on %s', async (_description, failure) => {
    const { instance } = policy([], failure);

    await expect(instance.resolve('MARKETPLACE')).rejects.toMatchObject({
      status: 503,
      message: 'Servicio temporalmente no disponible',
    });
    await expect(instance.resolve('MARKETPLACE')).rejects.not.toThrow(
      /relation|permission|persistence/,
    );
  });

  it('fails closed if the result shape is invalid', async () => {
    const { instance } = policy([{ product_id: null, variant_id: null }]);

    await expect(instance.resolve('MARKETPLACE')).rejects.toMatchObject({
      status: 503,
    });
  });
});
