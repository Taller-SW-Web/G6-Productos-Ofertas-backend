import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { IsolatedAuditPostgres } from '../../../apps/price-audit-svc/test/isolated-postgres.js';

interface QueuedItem {
  deliveryId: string;
  body: string;
  contentType: string;
  messageId: string;
  correlationId: string;
  subject: string;
  applicationProperties: Record<string, unknown>;
  deliveryCount: number;
}

interface BrokerStageEvent {
  at: string;
  stage: 'ENQUEUED' | 'RECEIVED' | 'COMPLETED' | 'ABANDONED' | 'DEADLETTERED';
  messageId: string;
  deliveryId: string;
  deliveryCount: number;
}

function createIsolatedR16Broker() {
  const queue: QueuedItem[] = [];
  const inflight = new Map<string, QueuedItem>();
  const completed: BrokerStageEvent[] = [];
  const deadLettered: BrokerStageEvent[] = [];
  const timeline: BrokerStageEvent[] = [];

  const enqueue = (item: Omit<QueuedItem, 'deliveryId' | 'deliveryCount'>) => {
    const entry: QueuedItem = {
      ...item,
      deliveryId: randomUUID(),
      deliveryCount: 0,
    };
    queue.push(entry);
    timeline.push({
      at: new Date().toISOString(),
      stage: 'ENQUEUED',
      messageId: entry.messageId,
      deliveryId: entry.deliveryId,
      deliveryCount: 0,
    });
    return entry;
  };

  const server = http.createServer((req, res) => {
    const url = req.url ?? '';
    if (
      req.method === 'GET' &&
      url === '/queues/g6.price-audit.from.pricing/peek'
    ) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(queue.slice(0, 1)));
      return;
    }
    if (
      req.method === 'POST' &&
      url === '/queues/g6.price-audit.from.pricing/receive'
    ) {
      const next = queue.shift();
      if (!next) {
        res.writeHead(204);
        res.end();
        return;
      }
      next.deliveryCount += 1;
      inflight.set(next.deliveryId, next);
      timeline.push({
        at: new Date().toISOString(),
        stage: 'RECEIVED',
        messageId: next.messageId,
        deliveryId: next.deliveryId,
        deliveryCount: next.deliveryCount,
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(next));
      return;
    }
    const completeMatch = url.match(
      /^\/queues\/g6\.price-audit\.from\.pricing\/complete\/([^/]+)$/,
    );
    if (req.method === 'POST' && completeMatch) {
      const deliveryId = decodeURIComponent(completeMatch[1]);
      const item = inflight.get(deliveryId);
      inflight.delete(deliveryId);
      if (item) {
        const ev: BrokerStageEvent = {
          at: new Date().toISOString(),
          stage: 'COMPLETED',
          messageId: item.messageId,
          deliveryId,
          deliveryCount: item.deliveryCount,
        };
        completed.push(ev);
        timeline.push(ev);
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    const abandonMatch = url.match(
      /^\/queues\/g6\.price-audit\.from\.pricing\/abandon\/([^/]+)$/,
    );
    if (req.method === 'POST' && abandonMatch) {
      const deliveryId = decodeURIComponent(abandonMatch[1]);
      const item = inflight.get(deliveryId);
      inflight.delete(deliveryId);
      if (item) {
        queue.push(item);
        timeline.push({
          at: new Date().toISOString(),
          stage: 'ABANDONED',
          messageId: item.messageId,
          deliveryId,
          deliveryCount: item.deliveryCount,
        });
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    const dlqMatch = url.match(
      /^\/queues\/g6\.price-audit\.from\.pricing\/deadletter\/([^/]+)$/,
    );
    if (req.method === 'POST' && dlqMatch) {
      const deliveryId = decodeURIComponent(dlqMatch[1]);
      const item = inflight.get(deliveryId);
      inflight.delete(deliveryId);
      if (item) {
        const ev: BrokerStageEvent = {
          at: new Date().toISOString(),
          stage: 'DEADLETTERED',
          messageId: item.messageId,
          deliveryId,
          deliveryCount: item.deliveryCount,
        };
        deadLettered.push(ev);
        timeline.push(ev);
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  return {
    server,
    queue,
    inflight,
    completed,
    deadLettered,
    timeline,
    enqueue,
  };
}

function buildR16PriceChangedMessage(params: {
  messageId: string;
  correlationId: string;
  sku: string;
  productId: string;
  previousPrice: string;
  newPrice: string;
  priceVersion: number;
}) {
  const occurredAt = new Date().toISOString();
  const envelope = {
    message_id: params.messageId,
    correlation_id: params.correlationId,
    operation_id: randomUUID(),
    causation_id: null,
    name: 'pricing.price.changed',
    schema_version: 1,
    producer: 'pricing-svc',
    kind: 'event',
    occurred_at: occurredAt,
    data: {
      target_type: 'SKU',
      product_id: params.productId,
      sku: params.sku,
      channel_id: 'MARKETPLACE',
      currency: 'PEN',
      price_type: 'REGULAR',
      previous_price: params.previousPrice,
      new_price: params.newPrice,
      operation: 'MODIFICACION',
      reason: 'H5_R16_RESTART_VERIFICATION',
      price_version: params.priceVersion,
      valid_from: occurredAt,
      batch_id: null,
      actor: {
        user_id: null,
        email: null,
        ip: null,
      },
    },
  };
  return {
    body: JSON.stringify(envelope),
    contentType: 'application/json',
    messageId: params.messageId,
    correlationId: params.correlationId,
    subject: 'pricing.price.changed',
    applicationProperties: {
      producer: 'pricing-svc',
      schema_version: 1,
      route_version: 1,
    },
  };
}

async function waitForCondition(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs = 20_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await delay(150);
  }
  return false;
}

async function allocatePort(): Promise<number> {
  return await new Promise<number>((resolvePort, rejectPort) => {
    const srv = http.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (!addr || typeof addr === 'string') {
        srv.close(() => rejectPort(new Error('No se pudo asignar puerto')));
        return;
      }
      const { port } = addr;
      srv.close(() => resolvePort(port));
    });
  });
}

async function spawnPriceAuditProcess(
  databaseUrl: string,
  isolatedBusUrl: string,
): Promise<{ child: ChildProcess; port: number; pid: number; logs: string[] }> {
  const entry = resolve(process.cwd(), 'dist/apps/price-audit-svc/main.js');
  if (!existsSync(entry)) {
    throw new Error(
      `Falta compilado ${entry}; ejecutar npm run build:price-audit-svc antes de esta prueba.`,
    );
  }
  const port = await allocatePort();
  const logs: string[] = [];
  const child = spawn(process.execPath, [entry], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      G6_SECURITY_MODE: 'SIMULATED_AUTH',
      SIMULATED_AUTH_ISSUER: `${isolatedBusUrl}/auth`,
      SIMULATED_AUTH_JWKS_URL: `${isolatedBusUrl}/auth/.well-known/jwks.json`,
      PRICE_AUDIT_SVC_PORT: String(port),
      DATABASE_URL: databaseUrl,
      PGSSLMODE: 'disable',
      MESSAGING_PROVIDER: 'AZURE_SERVICE_BUS',
      G6_SERVICE_BUS_PILOT_ENABLED: 'true',
      G6_ISOLATED_SERVICE_BUS_URL: isolatedBusUrl,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (chunk: Buffer) =>
    logs.push(chunk.toString('utf8')),
  );
  child.stderr?.on('data', (chunk: Buffer) =>
    logs.push(chunk.toString('utf8')),
  );
  const ready = await waitForCondition(async () => {
    if (child.exitCode !== null) {
      throw new Error(
        `price-audit-svc salió prematuramente (code=${child.exitCode}): ${logs.join('').slice(-600)}`,
      );
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health/ready`);
      return res.status === 200;
    } catch {
      return false;
    }
  }, 25_000);
  if (!ready || !child.pid) {
    child.kill('SIGKILL');
    throw new Error(
      `Timeout esperando readiness de price-audit-svc: ${logs.join('').slice(-600)}`,
    );
  }
  return { child, port, pid: child.pid, logs };
}

async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolveExit) => {
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // already dead
      }
      resolveExit();
    }, 5_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolveExit();
    });
    child.kill('SIGTERM');
  });
}

function getBackendSha(): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    }).trim();
  } catch {
    return null;
  }
}

describe.skipIf(process.env.G6_SERVICE_BUS_POSTGRES_TESTS !== '1')(
  'H5 R16: reinicio real de proceso consumidor price-audit-svc (aislado PG17 + broker HTTP)',
  () => {
    const auditPg = new IsolatedAuditPostgres();
    const broker = createIsolatedR16Broker();
    let brokerUrl = '';
    const activeChildren: ChildProcess[] = [];

    beforeAll(async () => {
      await auditPg.start();
      await new Promise<void>((resolveListen) => {
        broker.server.listen(0, '127.0.0.1', () => resolveListen());
      });
      const addr = broker.server.address();
      if (!addr || typeof addr === 'string') {
        throw new Error('No se pudo abrir broker HTTP aislado R16');
      }
      brokerUrl = `http://127.0.0.1:${addr.port}`;
    }, 120_000);

    afterAll(async () => {
      await Promise.allSettled(activeChildren.map((c) => stopProcess(c)));
      await new Promise<void>((resolveClose) =>
        broker.server.close(() => resolveClose()),
      );
      await auditPg.stop();
    });

    it('detiene el proceso price-audit-svc, encola entrega identificable y redelivery, reinicia y garantiza efecto único', async () => {
      const proc1 = await spawnPriceAuditProcess(auditPg.runtimeUrl, brokerUrl);
      activeChildren.push(proc1.child);

      const productId = randomUUID();
      const sku1 = `SKU-R16-A-${randomUUID().slice(0, 8).toUpperCase()}`;
      const sku2 = `SKU-R16-B-${randomUUID().slice(0, 8).toUpperCase()}`;
      const m1Id = randomUUID();
      const m1Corr = randomUUID();
      const m2Id = randomUUID();
      const m2Corr = randomUUID();

      const msg1 = buildR16PriceChangedMessage({
        messageId: m1Id,
        correlationId: m1Corr,
        sku: sku1,
        productId,
        previousPrice: '100.00',
        newPrice: '115.00',
        priceVersion: 1,
      });
      broker.enqueue(msg1);

      const m1Settled = await waitForCondition(
        () => broker.completed.filter((e) => e.messageId === m1Id).length >= 1,
      );
      expect(m1Settled).toBe(true);

      const beforeStopCount = (
        await auditPg.admin!.query<{ count: number }>(
          'SELECT count(*)::int AS count FROM price_audit.price_audit_log a JOIN price_audit.inbox i ON a.inbox_id = i.id WHERE i.message_id = $1',
          [m1Id],
        )
      ).rows[0].count;
      expect(beforeStopCount).toBe(1);

      // Detener el proceso consumidor real de price-audit-svc
      const stoppedPid = proc1.pid;
      await stopProcess(proc1.child);
      expect(
        proc1.child.exitCode !== null || proc1.child.signalCode !== null,
      ).toBe(true);

      // Con price-audit-svc caído, encolar nueva entrega identificable M2 y redelivery duplicado de M1
      const msg2 = buildR16PriceChangedMessage({
        messageId: m2Id,
        correlationId: m2Corr,
        sku: sku2,
        productId,
        previousPrice: '115.00',
        newPrice: '129.90',
        priceVersion: 2,
      });
      broker.enqueue(msg2);
      broker.enqueue(msg1);
      await delay(500);
      const queuedWhileStopped = broker.queue.length;
      expect(queuedWhileStopped).toBe(2);

      // Reiniciar un nuevo proceso real de price-audit-svc (PID distinto)
      const proc2 = await spawnPriceAuditProcess(auditPg.runtimeUrl, brokerUrl);
      activeChildren.push(proc2.child);
      const restartedPid = proc2.pid;
      expect(restartedPid).not.toBe(stoppedPid);

      const recovered = await waitForCondition(
        () =>
          broker.completed.filter((e) => e.messageId === m2Id).length >= 1 &&
          broker.completed.filter((e) => e.messageId === m1Id).length >= 2,
      );
      expect(recovered).toBe(true);

      // Redelivery adicional de M2 tras el reinicio para acreditar idempotencia post-recuperación
      broker.enqueue(msg2);
      const m2Redelivered = await waitForCondition(
        () => broker.completed.filter((e) => e.messageId === m2Id).length >= 2,
      );
      expect(m2Redelivered).toBe(true);

      const m1FinalCount = (
        await auditPg.admin!.query<{ count: number }>(
          'SELECT count(*)::int AS count FROM price_audit.price_audit_log a JOIN price_audit.inbox i ON a.inbox_id = i.id WHERE i.message_id = $1',
          [m1Id],
        )
      ).rows[0].count;
      const m2FinalCount = (
        await auditPg.admin!.query<{ count: number }>(
          'SELECT count(*)::int AS count FROM price_audit.price_audit_log a JOIN price_audit.inbox i ON a.inbox_id = i.id WHERE i.message_id = $1',
          [m2Id],
        )
      ).rows[0].count;

      expect(m1FinalCount).toBe(1);
      expect(m2FinalCount).toBe(1);
      expect(broker.deadLettered).toHaveLength(0);

      const evidenceOut = process.env.G6_R16_RESTART_EVIDENCE_PATH;
      if (evidenceOut) {
        const evidence = {
          evidenceType: 'R16_PRICE_AUDIT_CONSUMER_PROCESS_RESTART',
          criterion: 'H5-04B',
          flow: 'R16',
          queue: 'g6.price-audit.from.pricing',
          service: 'price-audit-svc',
          evidenceLevel: 'L1_ISOLATED',
          transport: 'HTTP_IN_MEMORY_NOT_AZURE',
          database: 'postgres17-disposable',
          generatedAtUtc: new Date().toISOString(),
          backendSha: getBackendSha(),
          contractVersion: '0.7.0-rc.3',
          processRestart: {
            kind: 'ACTUAL_LOCAL_PRICE_AUDIT_PROCESS_KILL_AND_RESTART',
            stoppedPid,
            restartedPid,
            queuedWhileStopped,
            limitation:
              'Broker HTTP en memoria local; demuestra reinicio real del proceso consumidor price-audit-svc, drenaje tras arranque, redelivery y efecto único en PG17, sin sustituir corrida L2 en Azure Service Bus.',
          },
          deliveries: {
            beforeStop: {
              messageId: m1Id,
              correlationId: m1Corr,
              sku: sku1,
              completedCount: broker.completed.filter(
                (e) => e.messageId === m1Id,
              ).length,
              auditRowsPersisted: m1FinalCount,
            },
            queuedDuringOutage: {
              messageId: m2Id,
              correlationId: m2Corr,
              sku: sku2,
              completedCount: broker.completed.filter(
                (e) => e.messageId === m2Id,
              ).length,
              auditRowsPersisted: m2FinalCount,
            },
          },
          deadLetterCount: broker.deadLettered.length,
          uniqueEffectsVerified: m1FinalCount === 1 && m2FinalCount === 1,
          status: 'PASS',
        };
        const jsonText = JSON.stringify(evidence, null, 2) + '\n';
        mkdirSync(dirname(evidenceOut), { recursive: true });
        writeFileSync(evidenceOut, jsonText, 'utf8');
        const metaPath = evidenceOut.replace(/\.json$/i, '.meta.json');
        writeFileSync(
          metaPath,
          JSON.stringify(
            {
              artifact: evidenceOut,
              sha256: createHash('sha256').update(jsonText).digest('hex'),
              generatedAtUtc: evidence.generatedAtUtc,
              backendSha: evidence.backendSha,
              transport: evidence.transport,
              evidenceLevel: evidence.evidenceLevel,
            },
            null,
            2,
          ) + '\n',
          'utf8',
        );
      }
    }, 90_000);
  },
);
