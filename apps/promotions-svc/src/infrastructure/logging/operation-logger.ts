import { httpContracts } from '../../http/http-contract.generated.js';
import { isUuid } from '../../http/http-validation.js';
import type { PromotionsReadiness } from '../../health/promotions-readiness.service.js';

export const PROMOTIONS_OPERATION_LOGGER = Symbol(
  'PROMOTIONS_OPERATION_LOGGER',
);
export type PromotionsCommercialStage = {
  correlationId: string;
  operation: string;
  upstream?: string;
  stage: string;
  durationMs: number;
  outcome:
    | 'success'
    | 'http_error'
    | 'input_error'
    | 'internal_error'
    | 'timeout'
    | 'cancelled';
  status?: number;
  errorCode?: string;
  deadlineMs?: number;
  budgetRemainingMs?: number;
  exhaustedStage?: string;
  pendingStageCount?: number;
  pendingStages?: string[];
  pendingOperations?: string[];
  pendingUpstreams?: string[];
};
// Only fixed operation identifiers, bounded numbers and validated correlation
// UUIDs cross this boundary. No request object, exception, URL, claims or payload.
export class PromotionsOperationLogger {
  constructor(
    private readonly write: (line: string) => void = (line) => {
      process.stdout.write(line + '\n');
    },
  ) {}
  http(
    operation: string,
    status: number,
    correlation: string,
    duration: number,
    code?: string,
  ): void {
    if (
      !Object.hasOwn(httpContracts, operation) ||
      !Number.isInteger(status) ||
      status < 100 ||
      status > 599 ||
      !isUuid(correlation)
    )
      return;
    const allowedCode =
      code && httpContracts[operation].errors[String(status)]?.includes(code)
        ? code
        : undefined;
    this.emit({
      timestamp: new Date().toISOString(),
      level: status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info',
      service: 'promotions-svc',
      operation,
      status,
      correlation_id: correlation,
      duration_ms: Number.isFinite(duration)
        ? Math.min(300000, Math.max(0, Math.round(duration)))
        : 0,
      ...(allowedCode ? { code: allowedCode } : {}),
    });
  }
  commercialStage(event: PromotionsCommercialStage): void {
    const fixed = (value: string, pattern: RegExp) => pattern.test(value);
    if (
      !isUuid(event.correlationId) ||
      !fixed(event.operation, /^[a-zA-Z][a-zA-Z0-9/]{0,79}$/) ||
      !fixed(event.stage, /^[a-z][a-z0-9_.-]{0,63}$/) ||
      (event.upstream !== undefined &&
        ![
          'catalog',
          'pricing',
          'inventory',
          'taxonomy',
          'ventas',
          'postgres',
        ].includes(event.upstream)) ||
      !Number.isFinite(event.durationMs) ||
      event.durationMs < 0 ||
      ![
        'success',
        'http_error',
        'input_error',
        'internal_error',
        'timeout',
        'cancelled',
      ].includes(event.outcome) ||
      (event.status !== undefined &&
        (!Number.isInteger(event.status) ||
          event.status < 100 ||
          event.status > 599)) ||
      (event.errorCode !== undefined &&
        !/^[A-Z][A-Z0-9_]{0,63}$/.test(event.errorCode)) ||
      (event.deadlineMs !== undefined &&
        (!Number.isFinite(event.deadlineMs) || event.deadlineMs < 0)) ||
      (event.budgetRemainingMs !== undefined &&
        !Number.isFinite(event.budgetRemainingMs)) ||
      (event.exhaustedStage !== undefined &&
        !fixed(event.exhaustedStage, /^[a-z][a-z0-9_.-]{0,63}$/)) ||
      (event.pendingStageCount !== undefined &&
        (!Number.isSafeInteger(event.pendingStageCount) ||
          event.pendingStageCount < 0)) ||
      !this.validLabels(event.pendingStages, /^[a-z][a-z0-9_.-]{0,63}$/) ||
      !this.validLabels(
        event.pendingOperations,
        /^[a-zA-Z][a-zA-Z0-9/]{0,79}$/,
      ) ||
      !this.validLabels(event.pendingUpstreams, /^[a-z][a-z0-9-]{0,31}$/)
    )
      return;
    this.emit({
      timestamp: new Date().toISOString(),
      level: event.outcome === 'success' ? 'info' : 'warn',
      service: 'promotions-svc',
      event: 'commercial_stage',
      correlation_id: event.correlationId,
      operation: event.operation,
      ...(event.upstream ? { upstream: event.upstream } : {}),
      stage: event.stage,
      duration_ms: Math.min(300000, Math.round(event.durationMs)),
      outcome: event.outcome,
      ...(event.status !== undefined ? { status: event.status } : {}),
      ...(event.errorCode ? { error_code: event.errorCode } : {}),
      ...(event.deadlineMs !== undefined
        ? { deadline_ms: Math.max(0, Math.round(event.deadlineMs)) }
        : {}),
      ...(event.budgetRemainingMs !== undefined
        ? {
            budget_remaining_ms: Math.max(
              0,
              Math.round(event.budgetRemainingMs),
            ),
          }
        : {}),
      ...(event.exhaustedStage
        ? { exhausted_stage: event.exhaustedStage }
        : {}),
      ...(event.pendingStageCount === undefined
        ? {}
        : { pending_stage_count: event.pendingStageCount }),
      ...(event.pendingStages ? { pending_stages: event.pendingStages } : {}),
      ...(event.pendingOperations
        ? { pending_operations: event.pendingOperations }
        : {}),
      ...(event.pendingUpstreams
        ? { pending_upstreams: event.pendingUpstreams }
        : {}),
    });
  }
  readiness(result: PromotionsReadiness): void {
    const statuses = ['up', 'down', 'disabled', 'not_implemented'];
    if (
      !['ready', 'not_ready'].includes(result.status) ||
      !statuses.includes(result.dependencies.database) ||
      !statuses.includes(result.dependencies.broker)
    )
      return;
    this.emit({
      timestamp: new Date().toISOString(),
      level: result.status === 'ready' ? 'info' : 'warn',
      service: 'promotions-svc',
      code:
        result.status === 'ready'
          ? 'DEPENDENCIES_READY'
          : 'DEPENDENCIES_NOT_READY',
      database: result.dependencies.database,
      broker: result.dependencies.broker,
    });
  }

  couponH5MessageTooLarge(operationId: string, messageId: string): void {
    if (!isUuid(operationId) || !isUuid(messageId)) return;
    this.emit({
      timestamp: new Date().toISOString(),
      level: 'error',
      service: 'promotions-svc',
      code: 'MESSAGE_TOO_LARGE',
      operation_id: operationId,
      message_id: messageId,
    });
  }

  private emit(value: Record<string, unknown>): void {
    try {
      this.write(JSON.stringify(value));
    } catch {
      /* Telemetry cannot change a business result. */
    }
  }

  private validLabels(values: string[] | undefined, pattern: RegExp): boolean {
    return (
      values === undefined ||
      (values.length <= 16 && values.every((value) => pattern.test(value)))
    );
  }
}
