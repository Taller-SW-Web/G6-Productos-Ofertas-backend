import { Injectable } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import { isCorrelationId } from './correlation.js';
import { SanitizedLogger } from './sanitized-logger.js';

export type CatalogSignal =
  | 'AMQP_LOCAL_RETRY'
  | 'AMQP_CONSUMER_PAUSED'
  | 'AMQP_CONNECTED'
  | 'AMQP_CONNECTION_FAILURE'
  | 'AMQP_CHANNEL_FAILURE'
  | 'AMQP_CONSUMER_FAILURE'
  | 'AMQP_CONSUMER_CANCELLED'
  | 'AMQP_CYCLE_PENDING'
  | 'AMQP_SHUTDOWN_PENDING'
  | 'OUTBOX_PUBLISHED'
  | 'OUTBOX_PENDING'
  | 'INBOX_APPLIED'
  | 'INBOX_STALE'
  | 'INBOX_TERMINAL'
  | 'INBOX_DUPLICATE'
  | 'MASTER_BARRIER_UNPROVEN_FINAL'
  | 'MASTER_BARRIER_BLOCKED_ASSOCIATION'
  | 'MASTER_BARRIER_OPERATION_CONFLICT'
  | 'MASTER_BARRIER_FINAL_PENDING';

export type CatalogDependencyStage =
  'g7_authorization' | 'pricing_response_headers' | 'pricing_response_body';
export type CatalogDependencyOutcome =
  'success' | 'error' | 'deadline' | 'http_error' | 'skipped';

/** Internal process indicators, not a new public metrics contract or health claim. */
@Injectable()
export class CatalogTelemetry {
  private readonly counts = new Map<string, number>();
  record(
    code: CatalogSignal,
    ids: {
      correlationId?: string;
      operationId?: string;
      messageId?: string;
    } = {},
  ): void {
    this.counts.set(code, (this.counts.get(code) ?? 0) + 1);
    const safeIds = Object.fromEntries(
      Object.entries(ids).filter(([, value]) => isCorrelationId(value)),
    );
    new SanitizedLogger('runtime').log({ code, ...safeIds });
  }

  dependencyStage(input: {
    correlationId?: string;
    dependency: 'g7' | 'pricing';
    stage: CatalogDependencyStage;
    outcome: CatalogDependencyOutcome;
    durationMs: number;
    status?: number;
    skuCount?: number;
  }): void {
    const durationMs = Number.isFinite(input.durationMs)
      ? Math.max(0, Math.round(input.durationMs))
      : 0;
    const status =
      Number.isInteger(input.status) &&
      input.status! >= 100 &&
      input.status! <= 599
        ? input.status
        : undefined;
    const skuCount =
      Number.isInteger(input.skuCount) &&
      input.skuCount! >= 0 &&
      input.skuCount! <= 100
        ? input.skuCount
        : undefined;
    new SanitizedLogger('runtime').log({
      code: 'DEPENDENCY_STAGE_COMPLETED',
      ...(isCorrelationId(input.correlationId)
        ? { correlationId: input.correlationId }
        : {}),
      dependency: input.dependency,
      stage: input.stage,
      outcome: input.outcome,
      durationMs,
      ...(status === undefined ? {} : { status }),
      ...(skuCount === undefined ? {} : { skuCount }),
    });
  }
  snapshot(): Readonly<Record<string, number>> {
    return Object.freeze(Object.fromEntries(this.counts));
  }
}

/** No raw URL, query, body, headers, subject or driver error enters the request log. */
export function catalogRequestLog(logger: SanitizedLogger) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const started = performance.now();
    res.once('finish', () =>
      logger.log({
        code: 'HTTP_REQUEST_COMPLETED',
        method: [
          'GET',
          'POST',
          'PATCH',
          'DELETE',
          'PUT',
          'HEAD',
          'OPTIONS',
        ].includes(req.method)
          ? req.method
          : 'OTHER',
        status: res.statusCode,
        durationMs: Math.max(0, Math.round(performance.now() - started)),
        correlationId: isCorrelationId(res.getHeader('X-Correlation-Id'))
          ? res.getHeader('X-Correlation-Id')
          : undefined,
      }),
    );
    next();
  };
}
