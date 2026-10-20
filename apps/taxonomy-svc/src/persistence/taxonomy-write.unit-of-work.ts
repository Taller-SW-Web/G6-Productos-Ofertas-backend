import type { TransaccionTaxonomy } from './drizzle-taxonomy.repository.js';

export interface TaxonomyWriteUnitOfWork {
  enTransaccion<T>(
    operacion: (tx: TransaccionTaxonomy) => Promise<T>,
  ): Promise<T>;
}
