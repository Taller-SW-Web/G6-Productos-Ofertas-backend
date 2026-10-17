import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Database } from './database.js';
import { PostgresTaxonomyRepository } from './postgres-taxonomy.repository.js';

describe('Taxonomy provider mapping and exact active filter (isolated)', () => {
  const queries: { text: string; values: unknown[] }[] = [];
  const pool = {
    async query(config: { text: string }, values: unknown[]) {
      queries.push({ text: config.text, values });
      const states = ['ACTIVO', 'INACTIVO', 'PENDING_DEACTIVATION'];
      return {
        rows: states.map((estado, index) =>
          config.text.includes('"categories"')
            ? ['category-' + index, 'Category fixture', null, estado]
            : ['brand-' + index, 'Brand fixture', null, null, null, estado],
        ),
      };
    },
  };
  const db = drizzle(pool as unknown as pg.Pool);
  const database = {
    read: <T>(callback: (connection: typeof db) => Promise<T>) => callback(db),
  };
  const repo = new PostgresTaxonomyRepository(database as Database);
  it('never exposes pending/inactive rows as active even if driver returns them', async () => {
    expect((await repo.findCategoriasActivas()).map((r) => r.estado)).toEqual([
      'ACTIVO',
    ]);
    expect((await repo.findMarcasActivas()).map((r) => r.estado)).toEqual([
      'ACTIVO',
    ]);
    for (const query of queries) {
      expect(query.text).toContain('where');
      expect(query.values).toEqual(['ACTIVO']);
      expect(query.text).not.toContain('select *');
      expect(query.text).not.toContain('"catalog"');
    }
  });
});
