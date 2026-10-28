import { randomUUID } from 'node:crypto';
import {
  CommercialDependencyError,
  type BasketRequest,
  type CommercialContext,
} from '../../domain/commercial-context.js';
import { Decimal } from '../../domain/decimal.js';
import { validInstant } from '../../domain/date-time.js';
import { effectiveAt } from '../../domain/promotion-rules.js';
import type { RecommendationCandidate } from '../../domain/promotion-rules.js';
import { withDeadline } from '../resilience/deadline.js';

type Operation =
  'obtenerProducto' | 'obtenerPrecioSku' | 'consultarDisponibilidadComercial';
const scopes: Record<Operation, string> = {
  obtenerProducto: 'catalogo:leer',
  obtenerPrecioSku: 'precios:leer',
  consultarDisponibilidadComercial: 'inventario:disponibilidad:leer',
};
export interface CommercialHttpOptions {
  origin: string;
  // Own service credentials supplied by the integration owner, never the inbound
  // user's/channel's token. This callback does not grant an absent allowlist.
  getServiceAccessToken(
    request: {
      operationId: Operation;
      audience: 'api-productos';
      scope: string;
    },
    signal: AbortSignal,
  ): Promise<string | null>;
}

/** Candidate outbound client, deliberately NOT registered in PromotionsSvcModule.
 * Current rc.1 allowlists exclude Promotions. No environment flag activates it.
 * Local fixture tests exercise HTTP/DTO logic, not a real grant/homologation.
 */
export class HttpCommercialContext implements CommercialContext {
  private readonly origin: string;
  constructor(private readonly options: CommercialHttpOptions) {
    const url = new URL(options.origin);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/' ||
      (url.protocol !== 'https:' &&
        !(
          url.protocol === 'http:' &&
          ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
        ))
    )
      throw new Error('INVALID_COMMERCIAL_ORIGIN');
    this.origin = url.origin;
  }

  private async read(
    operation: Operation,
    path: string,
    signal: AbortSignal,
    missing = false,
  ): Promise<unknown> {
    signal.throwIfAborted();
    const token = await this.options.getServiceAccessToken(
      {
        operationId: operation,
        audience: 'api-productos',
        scope: scopes[operation],
      },
      signal,
    );
    signal.throwIfAborted();
    if (!token || /\s/.test(token))
      throw new Error('COMMERCIAL_SESSION_UNAVAILABLE');
    const response = await fetch(this.origin + '/api/v1' + path, {
      signal,
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
      headers: {
        Authorization: 'Bearer ' + token,
        'X-Correlation-Id': randomUUID(),
        Accept: 'application/json',
      },
    });
    if (missing && response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    if (
      !response.ok ||
      !/^application\/json(?:\s*;|$)/i.test(
        response.headers.get('content-type') ?? '',
      )
    ) {
      await response.body?.cancel();
      throw new Error('COMMERCIAL_HTTP_UNAVAILABLE');
    }
    if (!response.body) throw new Error('COMMERCIAL_HTTP_UNAVAILABLE');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > 1_048_576) throw new Error('COMMERCIAL_RESPONSE_LIMIT');
        chunks.push(part.value);
      }
      return JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
      );
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }

  private async bounded<T>(
    operation: string,
    signal: AbortSignal | undefined,
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    try {
      signal?.throwIfAborted();
      return await withDeadline(
        (timeout) =>
          work(signal ? AbortSignal.any([signal, timeout]) : timeout),
        2500,
      );
    } catch {
      throw new CommercialDependencyError(
        operation,
        'Catálogo/Pricing/Inventario + integración G6/G7',
        'identidad propia autorizada y respuesta contractual completa y coherente; sin fallback ni reintento',
      );
    }
  }

  private async product(id: string, channel: string, signal: AbortSignal) {
    const raw = await this.read(
      'obtenerProducto',
      '/productos/' +
        encodeURIComponent(id) +
        '?canal=' +
        encodeURIComponent(channel),
      signal,
      true,
    );
    if (raw === null) return null; // Not commercially visible, never an authoritative admin absence.
    const row = object(raw);
    if (text(row.product_id) !== id || typeof row.tiene_variantes !== 'boolean')
      throw new Error('PRODUCT_IDENTITY_MISMATCH');
    text(row.name);
    text(row.slug);
    text(row.tipo_producto_id);
    text(row.marca_id);
    const categoryId = text(row.categoria_id);
    const brand = object(row.marca);
    if (text(brand.marca_id) !== row.marca_id)
      throw new Error('BRAND_IDENTITY_MISMATCH');
    text(brand.name);
    const variants = array(row.variants).map((value) => {
      const variant = object(value);
      return { id: text(variant.variant_id), sku: text(variant.sku) };
    });
    if (
      new Set(variants.map((v) => v.sku)).size !== variants.length ||
      new Set(variants.map((v) => v.id)).size !== variants.length
    )
      throw new Error('AMBIGUOUS_SKU');
    const skus = row.tiene_variantes
      ? variants.map((v) => v.sku)
      : [text(row.sku_base)];
    if (!row.tiene_variantes && variants.length)
      throw new Error('AMBIGUOUS_SIMPLE_PRODUCT');
    return { categoryId, skus, hasVariants: row.tiene_variantes };
  }

  private async price(
    sku: string,
    channel: string,
    at: string,
    signal: AbortSignal,
  ) {
    const row = object(
      await this.read(
        'obtenerPrecioSku',
        '/precios/skus/' +
          encodeURIComponent(sku) +
          '?canal=' +
          encodeURIComponent(channel) +
          '&at=' +
          encodeURIComponent(at),
        signal,
      ),
    );
    const regular = finitePositive(row.precio_regular);
    const offer =
      row.precio_oferta == null ? null : finitePositive(row.precio_oferta);
    const currency = text(row.currency);
    const from = text(row.valid_from);
    const until =
      row.valid_until === undefined || row.valid_until === null
        ? null
        : text(row.valid_until);
    if (
      text(row.sku) !== sku ||
      (row.channel_id !== null && row.channel_id !== channel) ||
      !validInstant(from) ||
      (until !== null && !validInstant(until)) ||
      !effectiveAt(from, until, at) ||
      !Number.isSafeInteger(row.price_version) ||
      Number(row.price_version) < 0 ||
      !['PRODUCTO', 'SKU_OVERRIDE'].includes(String(row.origen)) ||
      (offer !== null && Decimal.from(offer).compare(Decimal.from(regular)) > 0)
    )
      throw new Error('INVALID_PRICE_CONTEXT');
    text(row.vigencia_id);
    return { regular, offer, currency };
  }

  basket(request: BasketRequest, at: string, signal?: AbortSignal) {
    return this.bounded(
      'evaluarPromociones/validarCupon',
      signal,
      async (bounded) => {
        channel(request.channel_id);
        instant(at);
        if (
          !request.lines.length ||
          request.lines.some(
            (l) =>
              !l.product_id ||
              !l.sku ||
              !Number.isSafeInteger(l.quantity) ||
              l.quantity <= 0,
          )
        )
          throw new Error('CANONICAL_SKU_PRODUCT_RESOLVER_REQUIRED');
        const products = new Map<
          string,
          Awaited<ReturnType<HttpCommercialContext['product']>>
        >();
        const prices = new Map<
          string,
          Awaited<ReturnType<HttpCommercialContext['price']>>
        >();
        const lines = [];
        for (const line of request.lines) {
          const id = line.product_id!;
          if (!products.has(id))
            products.set(
              id,
              await this.product(id, request.channel_id, bounded),
            );
          const product = products.get(id);
          if (!product?.skus.includes(line.sku))
            throw new Error('SKU_NOT_COMMERCIALLY_VISIBLE');
          if (!prices.has(line.sku))
            prices.set(
              line.sku,
              await this.price(line.sku, request.channel_id, at, bounded),
            );
          lines.push({
            sku: line.sku,
            productId: id,
            quantity: line.quantity,
            ...prices.get(line.sku)!,
            active: true,
            channelEligible: true,
          });
        }
        if (new Set(lines.map((l) => l.currency)).size !== 1)
          throw new Error('MIXED_CURRENCIES');
        return { lines };
      },
    );
  }

  recommendationOrigin(
    productId: string,
    channelId: string,
    signal?: AbortSignal,
  ) {
    return this.bounded(
      'obtenerRecomendaciones/origen',
      signal,
      async (bounded) => {
        channel(channelId);
        text(productId);
        const p = await this.product(productId, channelId, bounded);
        return p
          ? { active: true, channelEligible: true, categoryId: p.categoryId }
          : { active: false, channelEligible: false, categoryId: '' };
      },
    );
  }

  recommendationProducts(
    ids: readonly string[],
    channelId: string,
    signal?: AbortSignal,
  ) {
    return this.bounded(
      'obtenerRecomendaciones/productos',
      signal,
      async (bounded) => {
        channel(channelId);
        const result = new Map<
          string,
          Pick<
            RecommendationCandidate,
            'active' | 'channelEligible' | 'availability' | 'currentPrice'
          >
        >();
        const products = new Map<string, string>();
        const at = new Date().toISOString();
        for (const id of new Set(ids)) {
          text(id);
          const p = await this.product(id, channelId, bounded);
          if (!p) throw new Error('RECOMMENDED_PRODUCT_NOT_VISIBLE');
          // D-REC-01/02 still open, even if only one variant is currently returned.
          if (p.hasVariants)
            throw new Error('MULTI_SKU_RECOMMENDATION_NOT_DEFINED');
          const sku = p.skus[0];
          if (!sku || sku.includes(','))
            throw new Error('UNREPRESENTABLE_SKU_LIST');
          products.set(id, sku);
        }
        const uniqueSkus = [...new Set(products.values())];
        const availability = new Map<
          string,
          RecommendationCandidate['availability']
        >();
        for (let offset = 0; offset < uniqueSkus.length; offset += 100) {
          const batch = uniqueSkus.slice(offset, offset + 100);
          const row = object(
            await this.read(
              'consultarDisponibilidadComercial',
              '/inventario/disponibilidad/comercial?skus=' +
                encodeURIComponent(batch.join(',')) +
                '&canal=' +
                encodeURIComponent(channelId),
              bounded,
            ),
          );
          for (const value of array(row.items)) {
            const item = object(value),
              sku = text(item.sku);
            if (
              !batch.includes(sku) ||
              availability.has(sku) ||
              !['DISPONIBLE', 'STOCK_BAJO', 'AGOTADO'].includes(
                String(item.status),
              )
            )
              throw new Error('UNDETERMINED_OR_INVALID_AVAILABILITY');
            availability.set(
              sku,
              item.status as RecommendationCandidate['availability'],
            );
          }
          if (batch.some((sku) => !availability.has(sku)))
            throw new Error('INCOMPLETE_AVAILABILITY');
        }
        for (const [id, sku] of products) {
          const price = await this.price(sku, channelId, at, bounded);
          result.set(id, {
            active: true,
            channelEligible: true,
            availability: availability.get(sku)!,
            currentPrice: Number(price.offer ?? price.regular),
          });
        }
        return result;
      },
    );
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('INVALID_COMMERCIAL_DTO');
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim())
    throw new Error('INVALID_COMMERCIAL_DTO');
  return value;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('INVALID_COMMERCIAL_DTO');
  return value;
}
function finitePositive(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
    throw new Error('INVALID_PRICE');
  return String(value);
}
function channel(value: string) {
  if (!['MARKETPLACE', 'CHATBOT', 'RETAIL'].includes(value))
    throw new Error('UNSUPPORTED_COMMERCIAL_CHANNEL');
}
function instant(value: string) {
  if (!validInstant(value)) throw new Error('INVALID_COMMERCIAL_INSTANT');
}
