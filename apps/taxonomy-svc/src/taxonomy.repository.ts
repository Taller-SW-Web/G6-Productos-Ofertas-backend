export const TAXONOMY_REPOSITORY = 'TAXONOMY_REPOSITORY';

export type EstadoTaxonomia = 'ACTIVO' | 'INACTIVO';

export interface CategoriaRow {
  id: string;
  nombre: string;
  categoria_padre_id: string | null;
  estado: EstadoTaxonomia;
}

export interface MarcaRow {
  id: string;
  nombre: string;
  descripcion: string | null;
  pais_origen_iso: string | null;
  estado: EstadoTaxonomia;
  logo_url?: string | null;
}

export interface TaxonomyRepository {
  findCategoriasActivas(): Promise<CategoriaRow[]>;
  findMarcasActivas(): Promise<MarcaRow[]>;
}
