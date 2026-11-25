import {
  CommercialDependencyError,
  CommercialInputError,
  type CommercialContext,
  type BasketRequest,
  type CommercialReadContext,
} from '../../domain/commercial-context.js';
import { PromotionsDependencyTimeout, withDeadline } from './deadline.js';

// Bounds the internal port even when a test/provider replacement hangs. Future
// authenticated adapters must pass the signal to transport and close on abort.
export class BoundedCommercialContext implements CommercialContext {
  constructor(
    private readonly source: CommercialContext,
    private readonly milliseconds = 2500,
  ) {}
  private async call<T>(
    operation: string,
    work: (signal: AbortSignal) => Promise<T>,
    context?: CommercialReadContext,
    parent?: AbortSignal,
  ): Promise<T> {
    const started = performance.now();
    const deadlineAt = context?.deadlineAt ?? started + this.milliseconds;
    if (context) {
      context.deadlineAt = deadlineAt;
      context.deadlineMs = this.milliseconds;
      context.stage ??= 'commercial_context';
    }
    try {
      const result = await withDeadline(
        work,
        Math.max(
          1,
          Math.floor(
            Math.min(this.milliseconds, deadlineAt - performance.now()),
          ),
        ),
      );
      context?.observe?.({
        operation,
        stage: 'commercial_context',
        durationMs: performance.now() - started,
        outcome: 'success',
        deadlineMs: this.milliseconds,
        budgetRemainingMs: Math.max(0, deadlineAt - performance.now()),
      });
      return result;
    } catch (error) {
      const timeout = error instanceof PromotionsDependencyTimeout;
      const cancelled =
        parent?.aborted === true ||
        (deadlineAt > performance.now() &&
          error instanceof Error &&
          error.name === 'AbortError');
      const exhaustedStage = timeout
        ? (context?.stage ?? 'commercial_context')
        : undefined;
      context?.observe?.({
        operation,
        stage: 'commercial_context',
        durationMs: performance.now() - started,
        outcome: timeout
          ? 'timeout'
          : cancelled
            ? 'cancelled'
            : 'internal_error',
        errorCode: timeout
          ? 'COMMERCIAL_DEADLINE_EXCEEDED'
          : cancelled
            ? 'DEPENDENCY_CANCELLED'
            : 'COMMERCIAL_CONTEXT_FAILED',
        deadlineMs: this.milliseconds,
        budgetRemainingMs: Math.max(0, deadlineAt - performance.now()),
        ...(exhaustedStage ? { exhaustedStage } : {}),
      });
      if (timeout) {
        throw new CommercialDependencyError(
          operation,
          'Catálogo/Pricing + integración G6',
          `deadline de ${this.milliseconds} ms agotado en ${exhaustedStage}`,
        );
      }
      if (
        error instanceof CommercialDependencyError ||
        error instanceof CommercialInputError
      )
        throw error;
      throw new CommercialDependencyError(
        operation,
        'Catálogo/Pricing + integración G6',
        'adaptador autenticado completo que respete cancelación y el límite de espera; sin reintento implícito',
      );
    }
  }
  basket(
    request: BasketRequest,
    at: string,
    parent?: AbortSignal,
    context?: CommercialReadContext,
  ) {
    return this.call(
      'evaluarPromociones/validarCupon',
      (signal) =>
        this.source.basket(
          request,
          at,
          parent ? AbortSignal.any([parent, signal]) : signal,
          context,
        ),
      context,
      parent,
    );
  }
  recommendationOrigin(
    productId: string,
    channel: string,
    parent?: AbortSignal,
    context?: CommercialReadContext,
  ) {
    return this.call(
      'obtenerRecomendaciones/origen',
      (signal) =>
        this.source.recommendationOrigin(
          productId,
          channel,
          parent ? AbortSignal.any([parent, signal]) : signal,
          context,
        ),
      context,
      parent,
    );
  }
  recommendationProducts(
    ids: readonly string[],
    channel: string,
    parent?: AbortSignal,
    context?: CommercialReadContext,
  ) {
    return this.call(
      'obtenerRecomendaciones/productos',
      (signal) =>
        this.source.recommendationProducts(
          ids,
          channel,
          parent ? AbortSignal.any([parent, signal]) : signal,
          context,
        ),
      context,
      parent,
    );
  }
}
