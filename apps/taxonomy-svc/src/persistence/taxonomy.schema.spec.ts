import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  categorySeo,
  characteristicValues,
  characteristics,
  categorias,
  esquemaTaxonomia,
  inbox,
  marcas,
  masterDeactivationOperations,
  outbox,
  productTypes,
  productTypeCharacteristics,
  runtimeSettings,
  slugHistory,
} from './taxonomy.schema.js';

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

  it('mapea las doce tablas del modelo físico únicamente bajo taxonomy', () => {
    const tablas = [
      [runtimeSettings, 'runtime_settings'],
      [categorias, 'categories'],
      [marcas, 'brands'],
      [characteristics, 'characteristics'],
      [characteristicValues, 'characteristic_values'],
      [productTypes, 'product_types'],
      [productTypeCharacteristics, 'product_type_characteristics'],
      [categorySeo, 'category_seo'],
      [slugHistory, 'slug_history'],
      [masterDeactivationOperations, 'master_deactivation_operations'],
      [outbox, 'outbox'],
      [inbox, 'inbox'],
    ] as const;

    expect(tablas).toHaveLength(12);
    for (const [tabla, nombre] of tablas) {
      const consulta = db.select().from(tabla).toSQL().sql;
      expect(consulta).toContain(`"taxonomy"."${nombre}"`);
    }
  });

  it('conserva los nombres físicos snake_case de las columnas extendidas', () => {
    const consultas = [
      [
        db
          .select({ valor: runtimeSettings.valorInteger })
          .from(runtimeSettings)
          .toSQL().sql,
        'valor_integer',
      ],
      [
        db
          .select({
            unidad: characteristics.unidadMedida,
            version: characteristics.taxonomyVersion,
          })
          .from(characteristics)
          .toSQL().sql,
        'unidad_medida',
      ],
      [
        db
          .select({ caracteristica: characteristicValues.caracteristicaId })
          .from(characteristicValues)
          .toSQL().sql,
        'caracteristica_id',
      ],
      [
        db
          .select({ version: productTypes.schemaVersion })
          .from(productTypes)
          .toSQL().sql,
        'schema_version',
      ],
      [
        db
          .select({ tipo: productTypeCharacteristics.tipoProductoId })
          .from(productTypeCharacteristics)
          .toSQL().sql,
        'tipo_producto_id',
      ],
      [
        db
          .select({
            categoria: categorySeo.categoriaId,
            titulo: categorySeo.metaTitulo,
          })
          .from(categorySeo)
          .toSQL().sql,
        'meta_titulo',
      ],
      [
        db.select({ slug: slugHistory.oldSlug }).from(slugHistory).toSQL().sql,
        'old_slug',
      ],
      [
        db
          .select({ operacion: masterDeactivationOperations.operationId })
          .from(masterDeactivationOperations)
          .toSQL().sql,
        'operation_id',
      ],
      [
        db.select({ mensaje: outbox.messageId }).from(outbox).toSQL().sql,
        'message_id',
      ],
      [
        db.select({ procesado: inbox.processedAt }).from(inbox).toSQL().sql,
        'processed_at',
      ],
    ] as const;

    for (const [consulta, columna] of consultas) {
      expect(consulta).toContain(`"${columna}"`);
    }
  });
});
