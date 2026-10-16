import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Request, Response } from 'express';
import { CONTRACT_ROUTES } from './contract-routes.js';
import { GatewayFailure, GatewayIdentity } from './gateway-identity.js';
import { GATEWAY_SETTINGS, type GatewaySettings } from './gateway-settings.js';
import type { ContractRoute } from './contract-route.js';
import { readLimitedResponse } from './bounded-response.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const routes = [...CONTRACT_ROUTES].sort(
  (a, b) =>
    (a.path.match(/\{/g)?.length ?? 0) - (b.path.match(/\{/g)?.length ?? 0),
);

export function matchContractRoute(
  method: string,
  path: string,
): ContractRoute | undefined {
  if (/\\|%2f|%5c|%00/i.test(path)) return undefined;
  const actual = path.split('/');
  try {
    if (actual.some((value) => ['.', '..'].includes(decodeURIComponent(value))))
      return undefined;
  } catch {
    return undefined;
  }
  return routes.find(
    (route) =>
      route.method === method &&
      route.path.split('/').length === actual.length &&
      route.path
        .split('/')
        .every((part, i) =>
          part.startsWith('{') ? actual[i].length > 0 : part === actual[i],
        ),
  );
}

async function readRequest(
  req: Request,
  max: number,
  signal: AbortSignal,
): Promise<Buffer> {
  if ('rawBody' in req && Buffer.isBuffer(req.rawBody)) return req.rawBody;
  if (req.body !== undefined) return Buffer.from(JSON.stringify(req.body));
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = () => {
      req.off('data', data);
      req.off('end', end);
      req.off('error', fail);
      req.off('aborted', fail);
      signal.removeEventListener('abort', abort);
    };
    const fail = () => {
      cleanup();
      reject(new GatewayFailure(503, 'SERVICIO_NO_DISPONIBLE'));
    };
    const abort = () => {
      req.resume();
      fail();
    };
    const data = (chunk: Buffer) => {
      size += chunk.length;
      if (size > max) {
        cleanup();
        req.resume();
        reject(new GatewayFailure(400, 'VALIDACION'));
      } else chunks.push(chunk);
    };
    const end = () => {
      cleanup();
      resolve(Buffer.concat(chunks));
    };
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
    req.on('data', data);
    req.on('end', end);
    req.on('error', fail);
    req.on('aborted', fail);
  });
}

@Injectable()
export class GatewayProxy {
  constructor(
    @Inject(GATEWAY_SETTINGS) private readonly settings: GatewaySettings,
    private readonly identity: GatewayIdentity,
  ) {}

  private problem(
    res: Response,
    route: ContractRoute,
    status: number,
    code: string,
    correlationId: string,
  ) {
    if (!route.responses[String(status)]?.codes.includes(code)) {
      status = 500;
      code = 'ERROR_INTERNO';
    }
    res
      .status(status)
      .type('application/problem+json')
      .json({
        title:
          status === 401
            ? 'No autenticado'
            : status === 403
              ? 'Permisos insuficientes'
              : status === 400
                ? 'Datos de entrada inválidos'
                : status === 503
                  ? 'Servicio no disponible'
                  : 'Error interno',
        status,
        code,
        correlationId,
      });
  }

  async forward(req: Request, res: Response): Promise<void> {
    const path = req.originalUrl.split('?')[0];
    const route = matchContractRoute(req.method, path);
    if (!route) {
      res.status(404).end();
      return;
    }
    const incomingCorrelation = req.header('x-correlation-id');
    const correlationId =
      incomingCorrelation && uuid.test(incomingCorrelation)
        ? incomingCorrelation
        : randomUUID();
    res.setHeader('X-Correlation-Id', correlationId);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.settings.timeoutMs);
    const disconnected = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.on('close', disconnected);
    try {
      const uniqueHeaders = new Set([
        'authorization',
        'x-correlation-id',
        'idempotency-key',
        ...route.headers.map((h) => h.name),
      ]);
      for (const name of uniqueHeaders) {
        let count = 0;
        for (let i = 0; i < req.rawHeaders.length; i += 2)
          if (req.rawHeaders[i].toLowerCase() === name) count++;
        if (count > 1) throw new GatewayFailure(400, 'VALIDACION');
      }
      if (incomingCorrelation && !uuid.test(incomingCorrelation))
        throw new GatewayFailure(400, 'VALIDACION');
      await this.identity.authorize(route, req.header('authorization'));
      const base = this.settings.upstreams[route.service];
      if (!base) throw new GatewayFailure(503, 'SERVICIO_NO_DISPONIBLE');
      const headers: Record<string, string> = {
        accept: req.header('accept') ?? 'application/json',
      };
      if (req.header('authorization'))
        headers.authorization = req.header('authorization')!;
      for (const header of route.headers) {
        const value =
          header.name === 'x-correlation-id'
            ? correlationId
            : req.header(header.name);
        if (
          (header.required && !value) ||
          (value &&
            ((header.minLength !== undefined &&
              value.length < header.minLength) ||
              (header.maxLength !== undefined &&
                value.length > header.maxLength)))
        )
          throw new GatewayFailure(400, 'VALIDACION');
        if (value) headers[header.name] = value;
      }
      const contentType = req.header('content-type');
      if (contentType) {
        if (
          !route.requestTypes.includes(
            contentType.split(';')[0].trim().toLowerCase(),
          )
        )
          throw new GatewayFailure(400, 'VALIDACION');
        headers['content-type'] = contentType;
      }
      const body = await readRequest(
        req,
        this.settings.maxBytes,
        controller.signal,
      );
      if (body.length > this.settings.maxBytes)
        throw new GatewayFailure(400, 'VALIDACION');
      const response = await fetch(new URL(req.originalUrl, base), {
        method: route.method,
        headers,
        redirect: 'manual',
        signal: controller.signal,
        body:
          body.length && !['GET', 'HEAD'].includes(route.method)
            ? new Uint8Array(body).buffer
            : undefined,
      });
      const contractResponse = route.responses[String(response.status)];
      if (
        !contractResponse ||
        (response.status >= 300 && response.status < 400)
      ) {
        await response.body?.cancel();
        throw new GatewayFailure(503, 'SERVICIO_NO_DISPONIBLE');
      }
      const payload = await readLimitedResponse(
        response,
        this.settings.maxBytes,
      );
      for (const header of contractResponse.headers) {
        const value = response.headers.get(header);
        if (value) res.setHeader(header, value);
      }
      if (response.status >= 400) {
        let code = '';
        try {
          const problem: unknown = JSON.parse(payload.toString('utf8'));
          if (
            problem &&
            typeof problem === 'object' &&
            'code' in problem &&
            typeof problem.code === 'string'
          )
            code = problem.code;
        } catch {
          /* Never forward raw upstream failures. */
        }
        this.problem(res, route, response.status, code, correlationId);
        return;
      }
      const responseType = response.headers
        .get('content-type')
        ?.split(';')[0]
        .trim()
        .toLowerCase();
      if (
        response.status !== 204 &&
        (!responseType || !contractResponse.types.includes(responseType))
      )
        throw new GatewayFailure(503, 'SERVICIO_NO_DISPONIBLE');
      if (responseType)
        res.setHeader('Content-Type', response.headers.get('content-type')!);
      res.status(response.status).send(payload);
    } catch (error: unknown) {
      const failure =
        error instanceof GatewayFailure
          ? error
          : new GatewayFailure(503, 'SERVICIO_NO_DISPONIBLE');
      if (!res.destroyed && !res.headersSent) {
        if (controller.signal.aborted) res.setHeader('Connection', 'close');
        this.problem(res, route, failure.status, failure.code, correlationId);
      }
    } finally {
      clearTimeout(timer);
      res.off('close', disconnected);
    }
  }
}
