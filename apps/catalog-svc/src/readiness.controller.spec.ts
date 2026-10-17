import { ServiceUnavailableException } from '@nestjs/common';
import { ReadinessController } from './readiness.controller.js';
import type { Database } from './database.js';
import type { CommercialService } from './commercial.service.js';
import type { CatalogConfig } from './config.js';
import type { PricingClient } from './pricing.client.js';

describe('Catalog readiness modes', () => {
  const database = { verifyIdentity: vi.fn() } as unknown as Database;
  const commercial = { list: vi.fn() } as unknown as CommercialService;
  const pricing = { checkReady: vi.fn() } as unknown as PricingClient;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(database.verifyIdentity).mockResolvedValue(undefined);
    vi.mocked(commercial.list).mockResolvedValue({
      items: [],
      pagina: 1,
      tamanio: 1,
      total: 0,
    });
    vi.mocked(pricing.checkReady).mockResolvedValue(undefined);
  });

  it('demo readiness checks Catalog and Pricing once without eligibility or a full price scan', async () => {
    const controller = new ReadinessController(
      database,
      commercial,
      { marketplaceDemoPreview: true } as CatalogConfig,
      pricing,
    );
    await expect(controller.ready()).resolves.toEqual({
      status: 'ready',
      service: 'catalog-svc',
    });
    expect(database.verifyIdentity).toHaveBeenCalledOnce();
    expect(pricing.checkReady).toHaveBeenCalledOnce();
    expect(commercial.list).not.toHaveBeenCalled();
  });

  it('demo readiness fails closed when Pricing is unavailable', async () => {
    vi.mocked(pricing.checkReady).mockRejectedValue(new Error('Pricing down'));
    const controller = new ReadinessController(
      database,
      commercial,
      { marketplaceDemoPreview: true } as CatalogConfig,
      pricing,
    );
    await expect(controller.ready()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(commercial.list).not.toHaveBeenCalled();
  });

  it('strict readiness keeps the commercial check when preview is disabled', async () => {
    const controller = new ReadinessController(
      database,
      commercial,
      { marketplaceDemoPreview: false } as CatalogConfig,
      pricing,
    );
    await expect(controller.ready()).resolves.toMatchObject({
      status: 'ready',
    });
    expect(commercial.list).toHaveBeenCalledOnce();
    expect(pricing.checkReady).not.toHaveBeenCalled();
  });

  it('fails readiness closed when the Catalog database is unavailable', async () => {
    vi.mocked(database.verifyIdentity).mockRejectedValue(
      new Error('database down'),
    );
    const controller = new ReadinessController(
      database,
      commercial,
      { marketplaceDemoPreview: true } as CatalogConfig,
      pricing,
    );
    await expect(controller.ready()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(pricing.checkReady).not.toHaveBeenCalled();
  });
});
