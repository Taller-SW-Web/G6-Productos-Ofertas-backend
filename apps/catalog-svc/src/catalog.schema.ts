import {
  pgSchema,
  uuid,
  text,
  boolean,
  integer,
  jsonb,
} from 'drizzle-orm/pg-core';

const catalog = pgSchema('catalog');
export const products = catalog.table('products', {
  id: uuid('id').notNull(),
  nombre: text('nombre').notNull(),
  descripcion: text('descripcion').notNull(),
  categoria_id: text('categoria_id').notNull(),
  tipo_producto_id: text('tipo_producto_id').notNull(),
  marca_id: text('marca_id').notNull(),
  sku_base: text('sku_base').notNull(),
  slug: text('slug').notNull(),
  tiene_variantes: boolean('tiene_variantes').notNull(),
  estado: text('estado').$type<'BORRADOR' | 'ACTIVO' | 'INACTIVO'>().notNull(),
});
export const variants = catalog.table('variants', {
  id: uuid('id').notNull(),
  product_id: uuid('product_id').notNull(),
  sku: text('sku').notNull(),
  estado: text('estado').$type<'BORRADOR' | 'ACTIVA' | 'INACTIVA'>().notNull(),
});
export const productImages = catalog.table('product_images', {
  id: uuid('id').notNull(),
  product_id: uuid('product_id').notNull(),
  url: text('url').notNull(),
  posicion: integer('posicion').notNull(),
});
export const variantImages = catalog.table('variant_images', {
  id: uuid('id').notNull(),
  variant_id: uuid('variant_id').notNull(),
  url: text('url').notNull(),
  posicion: integer('posicion').notNull(),
});
export const productAttributes = catalog.table('product_attribute_values', {
  id: uuid('id').notNull(),
  product_id: uuid('product_id').notNull(),
  caracteristica_id: text('caracteristica_id').notNull(),
  nombre_snapshot: text('nombre_snapshot').notNull(),
  valor_id: text('valor_id'),
  valor: jsonb('valor').$type<unknown>().notNull(),
});
export const variantAttributes = catalog.table('variant_attribute_values', {
  id: uuid('id').notNull(),
  variant_id: uuid('variant_id').notNull(),
  caracteristica_id: text('caracteristica_id').notNull(),
  nombre_snapshot: text('nombre_snapshot').notNull(),
  valor_id: text('valor_id'),
  valor: jsonb('valor').$type<unknown>().notNull(),
  es_identificador: boolean('es_identificador').notNull(),
});
