import { randomUUID } from 'node:crypto';

export function isCorrelationId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

export function correlationId(value: unknown): string {
  return isCorrelationId(value) ? value : randomUUID();
}
