import type {
  CategoriaRow,
  MarcaRow,
  TaxonomyRepository,
} from '../src/taxonomy.repository.js';

export class RepositorioPrueba implements TaxonomyRepository {
  categorias: CategoriaRow[] = [];
  marcas: MarcaRow[] = [];
  falla = false;
  detalleFallo = 'conexion con el esquema taxonomy rechazada';

  async findCategoriasActivas(): Promise<CategoriaRow[]> {
    if (this.falla) {
      throw new Error(this.detalleFallo);
    }
    return this.categorias;
  }

  async findMarcasActivas(): Promise<MarcaRow[]> {
    if (this.falla) {
      throw new Error(this.detalleFallo);
    }
    return this.marcas;
  }
}
