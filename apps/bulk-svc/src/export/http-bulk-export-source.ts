import {
  type BulkExportSource,
  type ExportCatalogRecord,
  type ExportPage,
  type ExportPriceRecord,
  type ExportStockRecord,
} from './bulk-export-source.js';

export interface HttpBulkExportConfig {
  readonly catalogUrl: string;
  readonly pricingUrl: string;
  readonly inventoryUrl: string;
  readonly tokenUrl: string;
  readonly clientId: string;
  readonly clientSecret: string;
}

export class HttpBulkExportSource implements BulkExportSource {
  private cachedToken?: { accessToken: string; expiresAt: number };
  private cachedSkus: string[] = [];

  constructor(private readonly config: HttpBulkExportConfig) {}

  private async getToken(signal: AbortSignal): Promise<string> {
    if (this.cachedToken && this.cachedToken.expiresAt > Date.now() + 5000) {
      return this.cachedToken.accessToken;
    }
    const response = await fetch(this.config.tokenUrl, {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        scope: 'catalogo:leer precios:leer inventario:disponibilidad:leer',
      }).toString(),
    });
    if (!response.ok) {
      throw new Error(`BULK_EXPORT_TOKEN_FAILED_${response.status}`);
    }
    const body = (await response.json()) as {
      accessToken?: string;
      expiresIn?: number;
    };
    if (!body.accessToken) throw new Error('BULK_EXPORT_TOKEN_EMPTY');
    this.cachedToken = {
      accessToken: body.accessToken,
      expiresAt: Date.now() + (body.expiresIn ?? 60) * 1000,
    };
    return body.accessToken;
  }

  async catalog(
    cursor: string | null,
    limit: number,
    signal: AbortSignal,
  ): Promise<ExportPage<ExportCatalogRecord>> {
    const page = cursor ? Number(cursor) : 1;
    const token = await this.getToken(signal);
    const url = new URL('/api/v1/productos', this.config.catalogUrl);
    url.searchParams.set('canal', 'MARKETPLACE');
    url.searchParams.set('pagina', String(page));
    url.searchParams.set('tamanio', String(Math.min(limit, 100)));
    const response = await fetch(url, {
      signal,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
      },
    });
    if (!response.ok) {
      throw new Error(`BULK_EXPORT_CATALOG_FAILED_${response.status}`);
    }
    const body = (await response.json()) as {
      items?: Array<{
        productId?: string;
        skuBase?: string;
        nombre?: string;
        descripcion?: string | null;
        categoriaId?: string;
        marcaId?: string;
        tipoProductoId?: string;
      }>;
      meta?: { pagina?: number; totalPaginas?: number };
    };
    const items: ExportCatalogRecord[] = (body.items ?? [])
      .filter((item) => item.productId && item.skuBase)
      .map((item) => ({
        productId: item.productId!,
        skuBase: item.skuBase!,
        variantSku: null,
        name: item.nombre ?? item.skuBase!,
        description: item.descripcion ?? null,
        categoryId: item.categoriaId ?? '',
        brandId: item.marcaId ?? '',
        productTypeId: item.tipoProductoId ?? '',
      }));
    if (page === 1) this.cachedSkus = [];
    for (const item of items) {
      if (!this.cachedSkus.includes(item.skuBase)) {
        this.cachedSkus.push(item.skuBase);
      }
    }
    const totalPages = body.meta?.totalPaginas ?? 1;
    const nextCursor = page < totalPages ? String(page + 1) : null;
    return {
      items,
      nextCursor,
      observedAt: new Date().toISOString(),
      version: `catalog-p${page}`,
    };
  }

  async pricing(
    cursor: string | null,
    limit: number,
    signal: AbortSignal,
    _at: string,
  ): Promise<ExportPage<ExportPriceRecord>> {
    if (!this.cachedSkus.length) {
      await this.catalog(null, limit, signal);
    }
    const offset = cursor ? Number(cursor) : 0;
    const slice = this.cachedSkus.slice(offset, offset + Math.min(limit, 100));
    if (!slice.length) {
      return {
        items: [],
        nextCursor: null,
        observedAt: new Date().toISOString(),
        version: 'pricing-empty',
      };
    }
    const token = await this.getToken(signal);
    const url = new URL('/api/v1/precios', this.config.pricingUrl);
    url.searchParams.set('skus', slice.join(','));
    const response = await fetch(url, {
      signal,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
      },
    });
    if (!response.ok) {
      throw new Error(`BULK_EXPORT_PRICING_FAILED_${response.status}`);
    }
    const body = (await response.json()) as {
      items?: Array<{
        sku?: string;
        productoId?: string | null;
        precioRegular?: string | number | null;
        precioOferta?: string | number | null;
        vigenciaOfertaInicio?: string | null;
        vigenciaOfertaFin?: string | null;
      }>;
    };
    const items: ExportPriceRecord[] = (body.items ?? []).map((p) => ({
      productId: p.productoId ?? null,
      sku: p.sku ?? null,
      regular: p.precioRegular != null ? Number(p.precioRegular) : null,
      offer: p.precioOferta != null ? Number(p.precioOferta) : null,
      offerStartsAt: p.vigenciaOfertaInicio ?? null,
      offerEndsAt: p.vigenciaOfertaFin ?? null,
    }));
    const nextOffset = offset + slice.length;
    return {
      items,
      nextCursor:
        nextOffset < this.cachedSkus.length ? String(nextOffset) : null,
      observedAt: new Date().toISOString(),
      version: `pricing-${offset}`,
    };
  }

  async inventory(
    cursor: string | null,
    limit: number,
    signal: AbortSignal,
  ): Promise<ExportPage<ExportStockRecord>> {
    if (!this.cachedSkus.length) {
      await this.catalog(null, limit, signal);
    }
    const offset = cursor ? Number(cursor) : 0;
    const slice = this.cachedSkus.slice(offset, offset + Math.min(limit, 100));
    if (!slice.length) {
      return {
        items: [],
        nextCursor: null,
        observedAt: new Date().toISOString(),
        version: 'inventory-empty',
      };
    }
    const token = await this.getToken(signal);
    const url = new URL(
      '/api/v1/inventario/disponibilidad',
      this.config.inventoryUrl,
    );
    url.searchParams.set('skus', slice.join(','));
    url.searchParams.set(
      'location_id',
      '00000000-0000-4000-8000-000000000101',
    );
    const response = await fetch(url, {
      signal,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
      },
    });
    if (!response.ok) {
      throw new Error(`BULK_EXPORT_INVENTORY_FAILED_${response.status}`);
    }
    const body = (await response.json()) as {
      items?: Array<{
        sku?: string;
        location_id?: string;
        on_hand?: number;
        reserved?: number;
        blocked?: number;
      }>;
    };
    const items: ExportStockRecord[] = (body.items ?? [])
      .filter((row) => row.sku)
      .map((row) => ({
        sku: row.sku!,
        locationId:
          row.location_id ?? '00000000-0000-4000-8000-000000000101',
        onHand: Number(row.on_hand ?? 0),
        reserved: Number(row.reserved ?? 0),
        blocked: Number(row.blocked ?? 0),
      }));
    const nextOffset = offset + slice.length;
    return {
      items,
      nextCursor:
        nextOffset < this.cachedSkus.length ? String(nextOffset) : null,
      observedAt: new Date().toISOString(),
      version: `inventory-${offset}`,
    };
  }
}
