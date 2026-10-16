import { pgSchema, uuid, text, integer } from 'drizzle-orm/pg-core';

const taxonomy = pgSchema('taxonomy');
export const categories = taxonomy.table('categories', {
  id: uuid('id').notNull(),
  nombre: text('nombre').notNull(),
  categoria_padre_id: uuid('categoria_padre_id'),
  orden: integer('orden').notNull(),
  estado: text('estado')
    .$type<'ACTIVO' | 'INACTIVO' | 'PENDING_DEACTIVATION'>()
    .notNull(),
});
export const brands = taxonomy.table('brands', {
  id: uuid('id').notNull(),
  nombre: text('nombre').notNull(),
  descripcion: text('descripcion'),
  pais_origen_iso: text('pais_origen_iso'),
  logo_url: text('logo_url'),
  estado: text('estado')
    .$type<'ACTIVO' | 'INACTIVO' | 'PENDING_DEACTIVATION'>()
    .notNull(),
});
