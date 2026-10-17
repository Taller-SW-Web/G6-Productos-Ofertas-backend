import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import {
  and,
  asc,
  desc,
  eq,
  exists,
  ilike,
  inArray,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { Database } from './database.js';
import {
  products,
  variants,
  productImages,
  variantImages,
  productAttributes,
  variantAttributes,
} from './catalog.schema.js';
import type {
  Attribute,
  ProductPage,
  ProductQuery,
  ProductSummary,
  CommercialVariant,
} from './commercial.types.js';
import type { EligibilitySelection } from './commercial-eligibility.js';

const projection = {
  product_id: products.id,
  slug: products.slug,
  name: products.nombre,
  description: products.descripcion,
  categoria_id: products.categoria_id,
  tipo_producto_id: products.tipo_producto_id,
  marca_id: products.marca_id,
  tiene_variantes: products.tiene_variantes,
  sku_base: products.sku_base,
};
const attributeProjection = {
  caracteristica_id: productAttributes.caracteristica_id,
  nombre: productAttributes.nombre_snapshot,
  valor_id: productAttributes.valor_id,
  valor: productAttributes.valor,
};

@Injectable()
export class PostgresCatalogRepository {
  constructor(private readonly database: Database) {}

  // Sin selección: candidato INTERNO, jamás acredita elegibilidad de un canal.
  private where(
    query: ProductQuery,
    selection?: EligibilitySelection,
  ): SQL | undefined {
    const conditions: SQL[] = [eq(products.estado, query.estado ?? 'ACTIVO')];
    if (query.q !== undefined) {
      const literal = query.q.replace(/[\\%_]/g, '\\$&');
      conditions.push(
        or(
          ilike(products.nombre, '%' + literal + '%'),
          ilike(products.descripcion, '%' + literal + '%'),
        )!,
      );
    }
    if (query.categoriaId !== undefined)
      conditions.push(eq(products.categoria_id, query.categoriaId));
    if (query.marcaId !== undefined)
      conditions.push(eq(products.marca_id, query.marcaId));
    if (
      selection &&
      (query.estado === undefined || query.estado === 'ACTIVO')
    ) {
      conditions.push(inArray(products.id, [...selection.productIds]));
      conditions.push(
        or(
          eq(products.tiene_variantes, false),
          exists(this.activeVariants(selection).where),
        )!,
      );
    }
    return and(...conditions);
  }

  private activeVariants(selection: EligibilitySelection) {
    // Fragmento correlacionado: solo productos con una variante activa elegible.
    return {
      where: sql`(SELECT 1 FROM ${variants} WHERE
      ${variants.product_id} = ${products.id} AND ${variants.estado} = ${'ACTIVA'}
      AND ${inArray(variants.id, [...selection.variantIds])})`,
    };
  }

  async listCandidates(
    query: ProductQuery,
    selection?: EligibilitySelection,
  ): Promise<ProductPage> {
    if (query.precioMin !== undefined || query.precioMax !== undefined)
      throw new ServiceUnavailableException();
    return this.database.read((db) =>
      db.transaction(
        async (tx) => {
          const where = this.where(query, selection);
          const [count] = await tx
            .select({ total: sql<number>`count(*)::integer` })
            .from(products)
            .where(where);
          const rows = await tx
            .select(projection)
            .from(products)
            .where(where)
            .orderBy(
              query.orden === 'NOMBRE_DESC'
                ? desc(products.nombre)
                : asc(products.nombre),
              asc(products.id),
            )
            .limit(query.tamanio)
            .offset((query.pagina - 1) * query.tamanio);
          const items: ProductSummary[] = [];
          for (const row of rows) {
            const images = await tx
              .select({ url: productImages.url })
              .from(productImages)
              .where(eq(productImages.product_id, row.product_id))
              .orderBy(asc(productImages.posicion), asc(productImages.id));
            const attributes: Attribute[] = await tx
              .select(attributeProjection)
              .from(productAttributes)
              .where(eq(productAttributes.product_id, row.product_id))
              .orderBy(asc(productAttributes.caracteristica_id));
            items.push({
              ...row,
              images: images.map((i) => i.url),
              attributes,
            });
          }
          return {
            items,
            pagina: query.pagina,
            tamanio: query.tamanio,
            total: count?.total ?? 0,
          };
        },
        { isolationLevel: 'repeatable read', accessMode: 'read only' },
      ),
    );
  }

  async findCandidateBySlug(
    slug: string,
    selection?: EligibilitySelection,
    canal: ProductQuery['canal'] = 'MARKETPLACE',
  ): Promise<(ProductSummary & { variants: CommercialVariant[] }) | null> {
    return this.database.read((db) =>
      db.transaction(
        async (tx) => {
          const [row] = await tx
            .select(projection)
            .from(products)
            .where(
              and(
                eq(products.slug, slug),
                this.where(
                  {
                    canal,
                    pagina: 1,
                    tamanio: 1,
                    orden: 'NOMBRE_ASC',
                  },
                  selection,
                ),
              ),
            )
            .limit(1);
          if (!row) return null;
          const images = await tx
            .select({ url: productImages.url })
            .from(productImages)
            .where(eq(productImages.product_id, row.product_id))
            .orderBy(asc(productImages.posicion), asc(productImages.id));
          const attributes = await tx
            .select(attributeProjection)
            .from(productAttributes)
            .where(eq(productAttributes.product_id, row.product_id))
            .orderBy(asc(productAttributes.caracteristica_id));
          const children = row.tiene_variantes
            ? await tx
                .select({
                  variant_id: variants.id,
                  sku: variants.sku,
                })
                .from(variants)
                .where(
                  and(
                    eq(variants.product_id, row.product_id),
                    eq(variants.estado, 'ACTIVA'),
                    selection
                      ? inArray(variants.id, [...selection.variantIds])
                      : undefined,
                  ),
                )
                .orderBy(asc(variants.id))
            : [];
          const result: CommercialVariant[] = [];
          for (const child of children) {
            const values = await tx
              .select({
                caracteristica_id: variantAttributes.caracteristica_id,
                nombre: variantAttributes.nombre_snapshot,
                valor_id: variantAttributes.valor_id,
                valor: variantAttributes.valor,
                identifying: variantAttributes.es_identificador,
              })
              .from(variantAttributes)
              .where(eq(variantAttributes.variant_id, child.variant_id))
              .orderBy(asc(variantAttributes.caracteristica_id));
            const gallery = await tx
              .select({ url: variantImages.url })
              .from(variantImages)
              .where(eq(variantImages.variant_id, child.variant_id))
              .orderBy(asc(variantImages.posicion), asc(variantImages.id));
            const attrs = (identifying: boolean): Attribute[] =>
              values
                .filter((v) => v.identifying === identifying)
                .map(({ identifying: _internal, ...attribute }) => attribute);
            result.push({
              ...child,
              identifying_attributes: attrs(true),
              non_identifying_attributes: attrs(false),
              images: gallery.map((i) => i.url),
            });
          }
          return {
            ...row,
            images: images.map((i) => i.url),
            attributes,
            variants: result,
          };
        },
        { isolationLevel: 'repeatable read', accessMode: 'read only' },
      ),
    );
  }

  async findCandidateByProductId(
    productId: string,
    selection: EligibilitySelection,
    canal: ProductQuery['canal'],
  ): Promise<(ProductSummary & { variants: CommercialVariant[] }) | null> {
    return this.database.read((db) =>
      db.transaction(
        async (tx) => {
          const [row] = await tx
            .select(projection)
            .from(products)
            .where(
              and(
                sql`${products.id}::text = ${productId}`,
                this.where(
                  {
                    canal,
                    pagina: 1,
                    tamanio: 1,
                    orden: 'NOMBRE_ASC',
                  },
                  selection,
                ),
              ),
            )
            .limit(1);
          if (!row) return null;
          const images = await tx
            .select({ url: productImages.url })
            .from(productImages)
            .where(eq(productImages.product_id, row.product_id))
            .orderBy(asc(productImages.posicion), asc(productImages.id));
          const attributes: Attribute[] = await tx
            .select(attributeProjection)
            .from(productAttributes)
            .where(eq(productAttributes.product_id, row.product_id))
            .orderBy(asc(productAttributes.caracteristica_id));
          const children = row.tiene_variantes
            ? await tx
                .select({ variant_id: variants.id, sku: variants.sku })
                .from(variants)
                .where(
                  and(
                    eq(variants.product_id, row.product_id),
                    eq(variants.estado, 'ACTIVA'),
                    inArray(variants.id, [...selection.variantIds]),
                  ),
                )
                .orderBy(asc(variants.id))
            : [];
          const commercialVariants: CommercialVariant[] = [];
          for (const child of children) {
            const values = await tx
              .select({
                caracteristica_id: variantAttributes.caracteristica_id,
                nombre: variantAttributes.nombre_snapshot,
                valor_id: variantAttributes.valor_id,
                valor: variantAttributes.valor,
                identifying: variantAttributes.es_identificador,
              })
              .from(variantAttributes)
              .where(eq(variantAttributes.variant_id, child.variant_id))
              .orderBy(asc(variantAttributes.caracteristica_id));
            const gallery = await tx
              .select({ url: variantImages.url })
              .from(variantImages)
              .where(eq(variantImages.variant_id, child.variant_id))
              .orderBy(asc(variantImages.posicion), asc(variantImages.id));
            const project = (identifying: boolean): Attribute[] =>
              values
                .filter((value) => value.identifying === identifying)
                .map(({ identifying: _internal, ...attribute }) => attribute);
            commercialVariants.push({
              ...child,
              identifying_attributes: project(true),
              non_identifying_attributes: project(false),
              images: gallery.map((image) => image.url),
            });
          }
          return {
            ...row,
            images: images.map((image) => image.url),
            attributes,
            variants: commercialVariants,
          };
        },
        { isolationLevel: 'repeatable read', accessMode: 'read only' },
      ),
    );
  }
}
