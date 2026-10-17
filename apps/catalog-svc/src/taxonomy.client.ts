import {
  HttpException,
  Injectable,
  Inject,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  CATALOG_TAXONOMY_CONFIG,
  readTaxonomyConfig,
  type TaxonomyConfig,
} from './taxonomy-config.js';
import type { CommercialBrand } from './commercial.types.js';

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
@Injectable()
export class TaxonomyClient {
  constructor(
    @Inject(CATALOG_TAXONOMY_CONFIG)
    private readonly config: TaxonomyConfig = readTaxonomyConfig(),
  ) {}

  private async get(
    path: string,
    key: string,
    correlationId?: string,
  ): Promise<Record<string, unknown>[]> {
    try {
      if (!this.config.origin) throw new Error();
      const url = new URL(this.config.origin);
      const response = await fetch(new URL(path, url), {
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
        headers: correlationId ? { 'x-correlation-id': correlationId } : {},
      });
      if (
        response.status !== 200 ||
        response.headers.get('content-type')?.split(';')[0] !==
          'application/json'
      ) {
        await response.body?.cancel();
        throw new Error();
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 1024 * 1024) throw new Error();
          chunks.push(value);
        }
      } finally {
        await reader.cancel();
      }
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (
        !object(body) ||
        !Array.isArray(body[key]) ||
        !body[key].every(object)
      )
        throw new Error();
      return body[key];
    } catch {
      throw new ServiceUnavailableException(
        'Servicio temporalmente no disponible',
      );
    }
  }
  async brand(id: string, correlationId?: string): Promise<CommercialBrand> {
    const rows = await this.get('/api/v1/marcas', 'brands', correlationId);
    if (
      rows.some(
        (r) =>
          typeof r.marca_id !== 'string' ||
          typeof r.name !== 'string' ||
          r.status !== 'ACTIVA' ||
          ['description', 'logo_url', 'country_code'].some(
            (k) =>
              r[k] !== undefined && r[k] !== null && typeof r[k] !== 'string',
          ),
      )
    )
      throw new ServiceUnavailableException();
    const row = rows.find((r) => r.marca_id === id);
    if (!row) throw new HttpException({ code: 'MARCA_INVALIDA' }, 422);
    return {
      marca_id: id,
      name: String(row.name),
      description: (row.description as string) ?? null,
      logo_url: (row.logo_url as string) ?? null,
      country_code: (row.country_code as string) ?? null,
    };
  }
  async category(id: string, correlationId?: string): Promise<void> {
    const rows = await this.get(
      '/api/v1/categorias',
      'categories',
      correlationId,
    );
    if (
      rows.some(
        (r) =>
          typeof r.categoria_id !== 'string' ||
          typeof r.name !== 'string' ||
          r.status !== 'ACTIVA',
      )
    )
      throw new ServiceUnavailableException();
    if (!rows.some((r) => r.categoria_id === id))
      throw new HttpException({ code: 'CATEGORIA_INVALIDA' }, 422);
  }
}
