import {
  CommercialDependencyError,
  CommercialInputError,
  type CommercialContext,
  type BasketRequest,
  type CommercialReadContext,
  type CommercialPendingStage,
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
      context.pendingStages ??= new Map();
    }
    let deadlineSnapshot: CommercialPendingStage[] | undefined;
    try {
      const result = await withDeadline(
        (signal) => {
          // This listener is installed before the adapter starts. Abort handlers
          // registered by concurrent reads therefore cannot mutate the snapshot.
          signal.addEventListener(
            'abort',
            () => {
              deadlineSnapshot = [...(context?.pendingStages?.values() ?? [])];
            },
            { once: true },
          );
          return work(signal);
        },
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
      const inputError = error instanceof CommercialInputError;
      const cancelled =
        parent?.aborted === true ||
        (deadlineAt > performance.now() &&
          error instanceof Error &&
          error.name === 'AbortError');
      const pending = timeout ? (deadlineSnapshot ?? []) : [];
      const exhaustedStage =
        deadlineSnapshot?.length === 1 ? pending[0].stage : undefined;
      const snapshotKnown =
        deadlineSnapshot !== undefined && pending.length > 0;
      const pendingStageCount = snapshotKnown ? pending.length : undefined;
      const pendingStages = timeout
        ? snapshotKnown
          ? [...new Set(pending.map((entry) => entry.stage))].sort()
          : ['unknown']
        : undefined;
      const pendingOperations = timeout
        ? snapshotKnown
          ? [...new Set(pending.map((entry) => entry.operation))].sort()
          : undefined
        : undefined;
      const pendingUpstreams = timeout
        ? snapshotKnown
          ? [...new Set(pending.map((entry) => entry.upstream))].sort()
          : undefined
        : undefined;
      context?.observe?.({
        operation,
        stage: 'commercial_context',
        durationMs: performance.now() - started,
        outcome: timeout
          ? 'timeout'
          : cancelled
            ? 'cancelled'
            : inputError
              ? 'input_error'
              : 'internal_error',
        errorCode: timeout
          ? 'COMMERCIAL_DEADLINE_EXCEEDED'
          : cancelled
            ? 'DEPENDENCY_CANCELLED'
            : inputError
              ? 'COMMERCIAL_INPUT_REJECTED'
              : 'COMMERCIAL_CONTEXT_FAILED',
        deadlineMs: this.milliseconds,
        budgetRemainingMs: Math.max(0, deadlineAt - performance.now()),
        ...(pendingStageCount === undefined ? {} : { pendingStageCount }),
        ...(pendingStages === undefined ? {} : { pendingStages }),
        ...(pendingOperations === undefined ? {} : { pendingOperations }),
        ...(pendingUpstreams === undefined ? {} : { pendingUpstreams }),
        ...(exhaustedStage ? { exhaustedStage } : {}),
      });
      if (timeout || cancelled) context?.pendingStages?.clear();
      if (timeout) {
        const timeoutDetail = exhaustedStage
          ? `deadline de ${this.milliseconds} ms agotado en ${exhaustedStage}`
          : snapshotKnown
            ? `deadline de ${this.milliseconds} ms agotado; ${pending.length} lecturas pendientes`
            : `deadline de ${this.milliseconds} ms agotado; etapa no atribuible (snapshot de lecturas desconocido)`;
        throw new CommercialDependencyError(
          operation,
          'Catálogo/Pricing + integración G6',
          timeoutDetail,
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
