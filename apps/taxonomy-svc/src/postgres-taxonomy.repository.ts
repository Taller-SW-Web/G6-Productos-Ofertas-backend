import { Injectable } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import { Database } from './database.js';
import { categories, brands } from './taxonomy.schema.js';
import type {
  TaxonomyRepository,
  CategoriaRow,
  MarcaRow,
} from './taxonomy.repository.js';

@Injectable()
export class PostgresTaxonomyRepository implements TaxonomyRepository {
  constructor(private readonly database: Database) {}

  async findCategoriasActivas(): Promise<CategoriaRow[]> {
    const rows = await this.database.read((db) =>
      db
        .select({
          id: categories.id,
          nombre: categories.nombre,
          categoria_padre_id: categories.categoria_padre_id,
          estado: categories.estado,
        })
        .from(categories)
        .where(eq(categories.estado, 'ACTIVO'))
        .orderBy(
          asc(categories.orden),
          asc(categories.nombre),
          asc(categories.id),
        ),
    );
    return rows.filter((row) => row.estado === 'ACTIVO');
  }

  async findMarcasActivas(): Promise<MarcaRow[]> {
    const rows = await this.database.read((db) =>
      db
        .select({
          id: brands.id,
          nombre: brands.nombre,
          descripcion: brands.descripcion,
          pais_origen_iso: brands.pais_origen_iso,
          logo_url: brands.logo_url,
          estado: brands.estado,
        })
        .from(brands)
        .where(eq(brands.estado, 'ACTIVO'))
        .orderBy(asc(brands.nombre), asc(brands.id)),
    );
    return rows.filter((row) => row.estado === 'ACTIVO');
  }

  async readiness(): Promise<boolean> {
    try {
      await this.database.verifyIdentity();
      await this.findCategoriasActivas();
      await this.findMarcasActivas();
      return true;
    } catch {
      return false;
    }
  }
}
