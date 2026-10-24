import { ForbiddenException } from '@nestjs/common';
import { CommercialService } from './commercial.service.js';
import type { ProductQuery } from './commercial.types.js';

describe('CommercialService', () => {
  const repository = {
    listCandidates: vi.fn(),
    findCandidateBySlug: vi.fn(),
    findCandidateByProductId: vi.fn(),
  };
  const taxonomy = { category: vi.fn(), brand: vi.fn() };
  const service = new CommercialService(repository as never, taxonomy as never);
  const query: ProductQuery = {
    canal: 'RETAIL',
    pagina: 1,
    tamanio: 20,
    orden: 'NOMBRE_ASC',
  };

  beforeEach(() => vi.clearAllMocks());

  it('passes channel context to the globally eligible product read', async () => {
    repository.findCandidateByProductId.mockResolvedValue({
      product_id: 'p-1',
      marca_id: 'brand-1',
    });
    taxonomy.brand.mockResolvedValue({ marca_id: 'brand-1', name: 'Brand' });
    await service.productById('p-1', 'RETAIL');
    expect(repository.findCandidateByProductId).toHaveBeenCalledWith(
      'p-1',
      'RETAIL',
    );
  });

  it('allows inactive administrative listing only when the caller is authorized', async () => {
    const adminQuery = { ...query, estado: 'INACTIVO' as const };
    repository.listCandidates.mockResolvedValue({ items: [], total: 0 });
    await expect(service.list(adminQuery, undefined, true)).resolves.toEqual({
      items: [],
      total: 0,
    });
    expect(repository.listCandidates).toHaveBeenCalledWith(adminQuery);
    await expect(service.list(adminQuery)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('queries global eligibility without a separate channel selection', async () => {
    repository.listCandidates.mockResolvedValue({ items: [], total: 0 });
    await service.list(query);
    expect(repository.listCandidates).toHaveBeenCalledWith(query);
  });
});
