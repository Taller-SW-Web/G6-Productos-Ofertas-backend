import {
  Catch,
  HttpException,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { correlationId, isCorrelationId } from './correlation.js';
import { CatalogPersistenceError } from './database-errors.js';

@Catch()
export class ProblemFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const request = context.getRequest<Request>();
    const response = context.getResponse<Response>();
    const databaseUnavailable =
      error instanceof CatalogPersistenceError &&
      error.failure === 'connection';
    const status =
      error instanceof HttpException
        ? error.getStatus()
        : databaseUnavailable
          ? 503
          : 500;
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
    const established = response.getHeader('X-Correlation-Id');
    const id = correlationId(
      isCorrelationId(established)
        ? established
        : request.headers['x-correlation-id'],
    );
    request.headers['x-correlation-id'] = id;
    response
      .status(status)
      .type('application/problem+json')
      .set('X-Correlation-Id', id)
      .json({
        type: '/errores/' + code.toLowerCase().replaceAll('_', '-'),
        title: code,
        status,
        code,
        correlationId: id,
      });
  }
}
