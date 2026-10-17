import { ForbiddenException } from '@nestjs/common';
import { CommercialService } from './commercial.service.js';
import type { ProductQuery } from './commercial.types.js';

describe('CommercialService', () => {
  const repository = {
    listCandidates: vi.fn(),
    findCandidateBySlug: vi.fn(),
    findCandidateByProductId: vi.fn(),
  };
  const eligibility = { resolve: vi.fn() };
  const taxonomy = { category: vi.fn(), brand: vi.fn() };
  const service = new CommercialService(
    repository as never,
    eligibility as never,
    taxonomy as never,
  );
  const query: ProductQuery = {
    canal: 'RETAIL',
    pagina: 1,
    tamanio: 20,
    orden: 'NOMBRE_ASC',
  };

  beforeEach(() => vi.clearAllMocks());

  it('passes the requested channel into product-id commercial eligibility', async () => {
    const selection = { productIds: ['p-1'], variantIds: [] };
    eligibility.resolve.mockResolvedValue(selection);
    repository.findCandidateByProductId.mockResolvedValue({
      product_id: 'p-1',
      marca_id: 'brand-1',
    });
    taxonomy.brand.mockResolvedValue({ marca_id: 'brand-1', name: 'Brand' });
    await service.productById('p-1', 'RETAIL');
    expect(eligibility.resolve).toHaveBeenCalledWith('RETAIL');
    expect(repository.findCandidateByProductId).toHaveBeenCalledWith(
      'p-1',
      selection,
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
    expect(eligibility.resolve).not.toHaveBeenCalled();
    expect(repository.listCandidates).toHaveBeenCalledWith(
      adminQuery,
      undefined,
    );
    await expect(service.list(adminQuery)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('keeps ordinary commercial listing behind the channel eligibility policy', async () => {
    const selection = { productIds: ['p-1'], variantIds: [] };
    eligibility.resolve.mockResolvedValue(selection);
    repository.listCandidates.mockResolvedValue({ items: [], total: 0 });
    await service.list(query);
    expect(eligibility.resolve).toHaveBeenCalledWith('RETAIL');
    expect(repository.listCandidates).toHaveBeenCalledWith(query, selection);
  });
});
