import {
  Catch,
  HttpException,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';

@Catch()
export class ProblemFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const request = context.getRequest<Request>();
    const response = context.getResponse<Response>();
    const status = error instanceof HttpException ? error.getStatus() : 500;
    const body =
      error instanceof HttpException ? error.getResponse() : undefined;
    const supplied =
      typeof body === 'object' && 'code' in body ? body.code : undefined;
    const code =
      status === 404
        ? 'PRODUCTO_NO_ENCONTRADO'
        : status === 422 &&
            ['CATEGORIA_INVALIDA', 'MARCA_INVALIDA'].includes(String(supplied))
          ? String(supplied)
          : status === 400
            ? 'VALIDACION'
            : status === 503
              ? 'SERVICIO_NO_DISPONIBLE'
              : 'ERROR_INTERNO';
    const raw = request.headers['x-correlation-id'];
    const correlationId =
      typeof raw === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        raw,
      )
        ? raw
        : randomUUID();
    response
      .status(status)
      .type('application/problem+json')
      .set('X-Correlation-Id', correlationId)
      .json({
        type: '/errores/' + code.toLowerCase().replaceAll('_', '-'),
        title: code,
        status,
        code,
        correlationId,
      });
  }
}
