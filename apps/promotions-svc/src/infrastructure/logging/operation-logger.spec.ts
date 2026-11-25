import { PromotionsOperationLogger } from './operation-logger.js';

const trace = '16b94161-fb80-43d5-baa5-edc46d95f9af';
describe('Sanitized operation telemetry', () => {
  it('emits only allowlisted fields, bounded latency and contract error codes', () => {
    const lines: string[] = [];
    const logger = new PromotionsOperationLogger((line) => lines.push(line));
    logger.http('listarPromocionesAdmin', 401, trace, 12.7, 'TOKEN_INVALIDO');
    logger.http(
      'listarPromocionesAdmin',
      500,
      trace,
      Infinity,
      'Bearer secret',
    );
    logger.http('listarPromocionesAdmin', 200, trace, 1e9);
    logger.http('listarPromocionesAdmin', 200, trace, -1);
    const entries = lines.map((line) => JSON.parse(line));
    expect(entries[0]).toEqual({
      timestamp: expect.any(String),
      level: 'warn',
      service: 'promotions-svc',
      operation: 'listarPromocionesAdmin',
      status: 401,
      correlation_id: trace,
      duration_ms: 13,
      code: 'TOKEN_INVALIDO',
    });
    expect(entries[1].duration_ms).toBe(0);
    expect(entries[1]).not.toHaveProperty('code');
    expect(entries[2].duration_ms).toBe(300000);
    expect(entries[3].duration_ms).toBe(0);
    expect(lines.join('')).not.toContain('secret');
  });
  it('rejects untrusted identifiers and cannot break requests on writer failure', () => {
    const write = vi.fn();
    const logger = new PromotionsOperationLogger(write);
    logger.http('constructor', 200, trace, 1);
    logger.http('/api/v1?secret', 200, trace, 1);
    logger.http('listarPromocionesAdmin', 200, 'secret\nforged', 1);
    logger.http('listarPromocionesAdmin', 600, trace, 1);
    expect(write).not.toHaveBeenCalled();
    expect(() =>
      new PromotionsOperationLogger(() => {
        throw new Error('sink');
      }).http('listarPromocionesAdmin', 200, trace, 1),
    ).not.toThrow();
  });
  it('copies only readiness states, ignoring attached connection diagnostics', () => {
    const write = vi.fn();
    const state = {
      status: 'not_ready' as const,
      service: 'promotions-svc' as const,
      dependencies: { database: 'down' as const, broker: 'disabled' as const },
      diagnostic: 'postgres://user:secret@host',
    };
    new PromotionsOperationLogger(write).readiness(state);
    expect(JSON.parse(write.mock.calls[0][0])).toEqual({
      timestamp: expect.any(String),
      level: 'warn',
      service: 'promotions-svc',
      code: 'DEPENDENCIES_NOT_READY',
      database: 'down',
      broker: 'disabled',
    });
    expect(write.mock.calls[0][0]).not.toContain('secret');
  });
  it('emits allowlisted commercial stage telemetry with correlation and no supplied secrets', () => {
    const lines: string[] = [];
    const logger = new PromotionsOperationLogger((line) => lines.push(line));
    logger.commercialStage({
      correlationId: trace,
      operation: 'obtenerPrecioSku',
      upstream: 'pricing',
      stage: 'upstream_request',
      durationMs: 554,
      outcome: 'http_error',
      status: 503,
      errorCode: 'UPSTREAM_HTTP_REJECTED',
      deadlineMs: 2500,
      budgetRemainingMs: 118,
      exhaustedStage: 'upstream_request',
    });
    logger.commercialStage({
      correlationId: 'invalid-correlation',
      operation: 'obtenerPrecioSku',
      upstream: 'pricing',
      stage: 'upstream_request',
      durationMs: 1,
      outcome: 'success',
    });
    const entry = JSON.parse(lines[0]);
    expect(entry).toMatchObject({
      event: 'commercial_stage',
      correlation_id: trace,
      operation: 'obtenerPrecioSku',
      upstream: 'pricing',
      stage: 'upstream_request',
      duration_ms: 554,
      outcome: 'http_error',
      status: 503,
      deadline_ms: 2500,
      budget_remaining_ms: 118,
      exhausted_stage: 'upstream_request',
    });
    expect(lines).toHaveLength(1);
    expect(lines.join('')).not.toContain('Bearer');
    expect(lines.join('')).not.toContain('secret');
  });
});
