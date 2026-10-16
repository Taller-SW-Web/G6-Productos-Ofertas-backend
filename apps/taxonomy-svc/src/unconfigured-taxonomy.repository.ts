import { ProblemDetailsException } from './errors/taxonomy.errors.js';
import type {
  CategoriaRow,
  MarcaRow,
  TaxonomyRepository,
} from './taxonomy.repository.js';

export class UnconfiguredTaxonomyRepository implements TaxonomyRepository {
  async findCategoriasActivas(): Promise<CategoriaRow[]> {
    throw ProblemDetailsException.noDisponible(
      'Fuente de datos de taxonomía no configurada: registra un proveedor TAXONOMY_REPOSITORY para consultar categorías.',
    );
  }

  async findMarcasActivas(): Promise<MarcaRow[]> {
    throw ProblemDetailsException.noDisponible(
      'Fuente de datos de taxonomía no configurada: registra un proveedor TAXONOMY_REPOSITORY para consultar marcas.',
    );
  }
}
