import { randomUUID } from 'node:crypto';
import type { CommercialReadContext } from '../../domain/commercial-context.js';
import { PromotionsDependencyTimeout } from '../resilience/deadline.js';

export type InternalOperation =
  | 'obtenerProducto'
  | 'obtenerContextoSku'
  | 'obtenerPrecioSku'
  | 'consultarDisponibilidadComercial'
  | 'obtenerEvidenciaReservaCuponInterno'
  | 'obtenerSnapshotCuponG5'
  | 'obtenerCategoriaAdmin';
export type Upstream =
  'catalog' | 'pricing' | 'inventory' | 'taxonomy' | 'ventas';
export type ServiceAudience = 'api-productos' | 'api-ventas';
export const internalOperations: Readonly<
  Record<
    InternalOperation,
    Readonly<{
      service: Upstream;
      scope: string;
      missing: string;
      clientId?: 'promotions-svc';
      audience?: ServiceAudience;
    }>
  >
> = {
  obtenerProducto: {
    service: 'catalog',
    scope: 'catalogo:leer',
    missing: 'PRODUCTO_NO_ENCONTRADO',
  },
  obtenerContextoSku: {
    service: 'catalog',
    scope: 'catalogo:leer',
    missing: 'SKU_NO_ENCONTRADO',
  },
  obtenerPrecioSku: {
    service: 'pricing',
    scope: 'precios:leer',
    missing: 'PRECIO_NO_ENCONTRADO',
  },
  consultarDisponibilidadComercial: {
    service: 'inventory',
    scope: 'inventario:disponibilidad:leer',
    missing: '',
  },
  obtenerEvidenciaReservaCuponInterno: {
    service: 'inventory',
    scope: 'inventario:reservas:estado:leer',
    missing: 'RESERVA_NO_ENCONTRADA',
    clientId: 'promotions-svc',
  },
  obtenerSnapshotCuponG5: {
    service: 'ventas',
    scope: 'ventas:pedidos:evidencia-cupon:leer',
    missing: '',
    clientId: 'promotions-svc',
    audience: 'api-ventas',
  },
  obtenerCategoriaAdmin: {
    service: 'taxonomy',
    scope: 'catalogo:leer',
    missing: 'CATEGORIA_NO_ENCONTRADA',
  },
};
export type ServiceAccessTokenSource = (
  request: {
    operationId: InternalOperation;
    audience: ServiceAudience;
    scope: string;
  },
  signal: AbortSignal,
  correlationId?: string,
) => Promise<string | null>;
export interface InternalHttpOptions {
  origin: string;
  origins?: Partial<Record<Upstream, string>>;
  mode?: 'AUTHENTICATED' | 'RESTRICTED_DEMO' | 'PUBLIC_READ_ONLY';
  getServiceAccessToken?: ServiceAccessTokenSource;
}

/** URL validation only; this does not verify DNS, routing or network isolation.
 * AUTHENTICATED sends a service bearer. Plain HTTP aliases are permitted solely
 * on the independently verified private g6-http network with trusted service DNS
 * and no public business ports; loopback is for same-host isolated processes.
 * Outside that boundary use HTTPS with certificate verification. See the PR143
 * transport/invalidation review for the release evidence required from infra.
 */
export function internalOrigin(
  value: string,
  demo: boolean,
  service?: Upstream,
): string {
  const url = new URL(value);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  const privateService = service && url.hostname === `${service}-svc`;
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    !['https:', 'http:'].includes(url.protocol) ||
    (service === 'ventas' && url.protocol !== 'https:') ||
    (demo
      ? !loopback && !privateService
      : url.protocol !== 'https:' && !loopback && !privateService)
  )
    throw new Error('INVALID_COMMERCIAL_ORIGIN');
  return url.origin;
}

// Bounded transport only: callers own their deadline and business DTO validation.
// Incoming user headers never enter this interface. Demo is explicit and restricted.
export class InternalHttpReader {
  private readonly origins: Partial<Record<Upstream, string>>;
  private readonly fallback: string;
  constructor(private readonly options: InternalHttpOptions) {
    const demo = options.mode === 'RESTRICTED_DEMO';
    // With explicit upstreams, origin is used only as a compatibility fallback.
    const firstService = (
      Object.keys(options.origins ?? {}) as Upstream[]
    ).find((service) => options.origins?.[service] === options.origin);
    this.fallback = internalOrigin(options.origin, demo, firstService);
    this.origins = Object.fromEntries(
      Object.entries(options.origins ?? {}).map(([service, origin]) => [
        service,
        internalOrigin(origin, demo, service as Upstream),
      ]),
    );
  }

  async read(
    operation: InternalOperation,
    path: string,
    signal: AbortSignal,
    missing = false,
    correlationId?: string,
    trace?: CommercialReadContext,
  ): Promise<unknown> {
    signal.throwIfAborted();
    if (
      correlationId !== undefined &&
      !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(correlationId)
    )
      throw new Error('INVALID_COMMERCIAL_CORRELATION');
    const spec = internalOperations[operation];
    const operationName = operation;
    const callId = randomUUID();
    const pendingStage = (stage: string) => {
      trace?.pendingStages?.set(callId, {
        operation: operationName,
        upstream: spec.service,
        stage,
      });
    };
    const remaining = () =>
      trace?.deadlineAt === undefined
        ? undefined
        : Math.max(0, trace.deadlineAt - performance.now());
    const emit = (
      stage: string,
      started: number,
      outcome:
        'success' | 'http_error' | 'internal_error' | 'timeout' | 'cancelled',
      status?: number,
      errorCode?: string,
    ) => {
      // Keep an aborted read in the live registry until the global deadline
      // observer snapshots it; sibling abort handlers must not make the set
      // appear empty or change which dependency is attributed.
      if (!signal.aborted) trace?.pendingStages?.delete(callId);
      if (!trace?.observe || !trace.correlationId) return;
      trace.observe({
        operation: operationName,
        upstream: spec.service,
        stage,
        durationMs: performance.now() - started,
        outcome,
        ...(status === undefined ? {} : { status }),
        ...(errorCode === undefined ? {} : { errorCode }),
        ...(trace?.deadlineMs === undefined
          ? {}
          : { deadlineMs: trace.deadlineMs }),
        ...(remaining() === undefined
          ? {}
          : { budgetRemainingMs: remaining() }),
      });
    };
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'X-Correlation-Id': correlationId ?? randomUUID(),
    };
    if (
      spec.service === 'ventas' ||
      (this.options.mode !== 'RESTRICTED_DEMO' &&
        this.options.mode !== 'PUBLIC_READ_ONLY')
    ) {
      // Own service credentials only. For HTTP aliases, the deployment must first
      // prove the private network above; an alias string alone proves no secrecy.
      const tokenStarted = performance.now();
      pendingStage('service_token');
      let token: string | null | undefined;
      try {
        const tokenRequest = {
          operationId: operation,
          audience: spec.audience ?? 'api-productos',
          scope: spec.scope,
        };
        token = trace?.correlationId
          ? await this.options.getServiceAccessToken?.(
              tokenRequest,
              signal,
              trace.correlationId,
            )
          : await this.options.getServiceAccessToken?.(tokenRequest, signal);
        if (!token || /\s/.test(token))
          throw new Error('COMMERCIAL_SESSION_UNAVAILABLE');
        emit('service_token', tokenStarted, 'success');
      } catch {
        const aborted = signal.aborted;
        const timeout = aborted && remaining() === 0;
        emit(
          'service_token',
          tokenStarted,
          timeout ? 'timeout' : aborted ? 'cancelled' : 'internal_error',
          undefined,
          timeout
            ? 'COMMERCIAL_DEADLINE_EXCEEDED'
            : aborted
              ? 'DEPENDENCY_CANCELLED'
              : 'SERVICE_TOKEN_UNAVAILABLE',
        );
        if (timeout) throw new PromotionsDependencyTimeout();
        throw new Error(
          aborted
            ? 'COMMERCIAL_REQUEST_CANCELLED'
            : 'COMMERCIAL_SESSION_UNAVAILABLE',
        );
      }
      signal.throwIfAborted();
      headers.Authorization = 'Bearer ' + token;
    }
    const origin = this.origins[spec.service];
    if (spec.service === 'ventas' && !origin)
      throw new Error('COMMERCIAL_HTTP_UNAVAILABLE');
    const requestStarted = performance.now();
    pendingStage('upstream_request');
    let response: Response;
    try {
      response = await fetch((origin ?? this.fallback) + '/api/v1' + path, {
        signal,
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
        headers,
      });
    } catch {
      const aborted = signal.aborted;
      const timeout = aborted && remaining() === 0;
      emit(
        'upstream_request',
        requestStarted,
        timeout ? 'timeout' : aborted ? 'cancelled' : 'internal_error',
        undefined,
        timeout
          ? 'COMMERCIAL_DEADLINE_EXCEEDED'
          : aborted
            ? 'DEPENDENCY_CANCELLED'
            : 'UPSTREAM_CONNECTION_FAILED',
      );
      if (timeout) throw new PromotionsDependencyTimeout();
      throw new Error(
        aborted
          ? 'COMMERCIAL_REQUEST_CANCELLED'
          : 'COMMERCIAL_HTTP_UNAVAILABLE',
      );
    }
    if (
      !response.body ||
      !/^application\/(?:json|problem\+json)(?:\s*;|$)/i.test(
        response.headers.get('content-type') ?? '',
      )
    ) {
      await response.body?.cancel();
      emit(
        'upstream_request',
        requestStarted,
        'http_error',
        response.status,
        'INVALID_UPSTREAM_CONTENT_TYPE',
      );
      throw new Error('COMMERCIAL_HTTP_UNAVAILABLE');
    }
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
      const data: unknown = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
      );
      if (
        missing &&
        response.status === 404 &&
        typeof data === 'object' &&
        data !== null &&
        'status' in data &&
        data.status === 404 &&
        'code' in data &&
        data.code === spec.missing
      ) {
        emit('upstream_request', requestStarted, 'success', response.status);
        return null;
      }
      if (
        !response.ok ||
        (spec.service === 'ventas' && response.status !== 200) ||
        !/^application\/json(?:\s*;|$)/i.test(
          response.headers.get('content-type') ?? '',
        )
      ) {
        emit(
          'upstream_request',
          requestStarted,
          'http_error',
          response.status,
          'UPSTREAM_HTTP_REJECTED',
        );
        throw new Error('COMMERCIAL_HTTP_UNAVAILABLE');
      }
      emit('upstream_request', requestStarted, 'success', response.status);
      return data;
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === 'COMMERCIAL_HTTP_UNAVAILABLE'
      )
        throw error;
      const aborted = signal.aborted;
      emit(
        'upstream_request',
        requestStarted,
        aborted ? 'cancelled' : 'internal_error',
        response.status,
        aborted ? 'DEPENDENCY_CANCELLED' : 'UPSTREAM_RESPONSE_INVALID',
      );
      throw new Error(
        aborted
          ? 'COMMERCIAL_REQUEST_CANCELLED'
          : 'COMMERCIAL_HTTP_UNAVAILABLE',
      );
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }
}
