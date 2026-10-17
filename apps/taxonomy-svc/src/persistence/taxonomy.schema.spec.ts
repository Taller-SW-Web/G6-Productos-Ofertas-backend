import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { categorias, esquemaTaxonomia, marcas } from './taxonomy.schema.js';

describe('taxonomy.schema (#35)', () => {
  const db = drizzle.mock({ schema: esquemaTaxonomia });

  it('mapea taxonomy.categories con nombres snake_case', () => {
    const { sql } = db
      .select({
        id: categorias.id,
        padre: categorias.categoriaPadreId,
        version: categorias.taxonomyVersion,
        creado: categorias.createdAt,
      })
      .from(categorias)
      .where(eq(categorias.estado, 'ACTIVO'))
      .toSQL();

    expect(sql).toContain('"taxonomy"."categories"');
    expect(sql).toContain('"categoria_padre_id"');
    expect(sql).toContain('"taxonomy_version"');
    expect(sql).toContain('"created_at"');
    expect(sql).toContain('"estado"');
  });

  it('mapea taxonomy.brands incluida la columna generada y char(2)', () => {
    const { sql } = db
      .select({
        normalizado: marcas.nombreNormalizado,
        pais: marcas.paisOrigenIso,
        logo: marcas.logoUrl,
      })
      .from(marcas)
      .toSQL();

    expect(sql).toContain('"taxonomy"."brands"');
    expect(sql).toContain('"nombre_normalizado"');
    expect(sql).toContain('"pais_origen_iso"');
    expect(sql).toContain('"logo_url"');
  });

  it('declara el enum taxonomy.estado_entidad con sus tres valores', () => {
    expect(esquemaTaxonomia.estadoEntidad.enumName).toBe('estado_entidad');
    expect(esquemaTaxonomia.estadoEntidad.schema).toBe('taxonomy');
    expect(esquemaTaxonomia.estadoEntidad.enumValues).toEqual([
      'ACTIVO',
      'INACTIVO',
      'PENDING_DEACTIVATION',
    ]);
  });
});
