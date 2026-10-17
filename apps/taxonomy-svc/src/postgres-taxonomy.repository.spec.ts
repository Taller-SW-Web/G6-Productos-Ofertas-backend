import { HttpStatus } from '@nestjs/common';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { TaxonomyDataSource } from './postgres-taxonomy.repository.js';
import { PostgresTaxonomyRepository } from './postgres-taxonomy.repository.js';
import { ProblemDetailsException } from './errors/taxonomy.errors.js';

function crearPoolFalso(
  queries: { text: string; values: unknown[] }[],
): pg.Pool {
  return {
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
  } as unknown as pg.Pool;
}

describe('Taxonomy provider mapping and exact active filter (isolated)', () => {
  const queries: { text: string; values: unknown[] }[] = [];
  const db = drizzle(crearPoolFalso(queries));
  const database: TaxonomyDataSource = {
    read: <T>(callback: (connection: typeof db) => Promise<T>) => callback(db),
    verifyIdentity: () => Promise.resolve(),
  };
  const repo = new PostgresTaxonomyRepository(database);

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

describe('PostgresTaxonomyRepository.readiness (producción)', () => {
  it('usa sondeos acotados (columnas explícitas y LIMIT 1) sin recorrer tablas', async () => {
    const queries: { text: string; values: unknown[] }[] = [];
    const db = drizzle(crearPoolFalso(queries));
    const database: TaxonomyDataSource = {
      read: <T>(callback: (connection: typeof db) => Promise<T>) =>
        callback(db),
      verifyIdentity: () => Promise.resolve(),
    };
    const repo = new PostgresTaxonomyRepository(database);

    await expect(repo.readiness()).resolves.toBe(true);

    const sondeos = queries.filter(
      (q) => q.text.includes('"categories"') || q.text.includes('"brands"'),
    );
    expect(sondeos).toHaveLength(2);
    for (const sondeo of sondeos) {
      expect(sondeo.text).toContain('limit');
      expect(sondeo.text).toContain('where');
      expect(sondeo.text).not.toContain('select *');
    }
  });

  it('devuelve false si falla la verificación de identidad', async () => {
    const database: TaxonomyDataSource = {
      read: () => Promise.reject(new Error('no deberia usarse')),
      verifyIdentity: () => Promise.reject(new Error('identidad invalida')),
    };
    const repo = new PostgresTaxonomyRepository(database);

    await expect(repo.readiness()).resolves.toBe(false);
  });

  it('devuelve false si un sondeo falla (permiso denegado / conexión caída)', async () => {
    const database: TaxonomyDataSource = {
      read: () =>
        Promise.reject(
          Object.assign(new Error('permission denied'), { code: '42501' }),
        ),
      verifyIdentity: () => Promise.resolve(),
    };
    const repo = new PostgresTaxonomyRepository(database);

    await expect(repo.readiness()).resolves.toBe(false);
  });

  it('verificarReadiness traduce readiness=false a 503', async () => {
    const database: TaxonomyDataSource = {
      read: () => Promise.reject(new Error('caida')),
      verifyIdentity: () => Promise.resolve(),
    };
    const repo = new PostgresTaxonomyRepository(database);

    const error = await repo.verificarReadiness().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProblemDetailsException);
    expect((error as ProblemDetailsException).getStatus()).toBe(
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  });
});
