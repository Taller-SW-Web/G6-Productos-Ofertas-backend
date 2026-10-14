import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import type { Response, Request } from 'express';
import {
  ProblemDetailsException,
  ProblemDetailsBody,
} from './inventory.errors.js';

@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const correlationIdHeader =
      (request.headers['x-correlation-id'] as string) ||
      (request.headers['correlation-id'] as string);

    if (exception instanceof ProblemDetailsException) {
      const problem = exception.problem;
      if (!problem.correlationId && correlationIdHeader) {
        problem.correlationId = correlationIdHeader;
      }
      return response
        .status(problem.status)
        .header('Content-Type', 'application/problem+json')
        .json(problem);
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const res = exception.getResponse();
      const detail =
        typeof res === 'string'
          ? res
          : typeof res === 'object' && res !== null && 'message' in res
            ? Array.isArray((res as { message: unknown }).message)
              ? (res as { message: string[] }).message.join('; ')
              : String((res as { message: unknown }).message)
            : exception.message;

      const code =
        status === HttpStatus.BAD_REQUEST
          ? 'VALIDACION'
          : status === HttpStatus.NOT_FOUND
            ? 'NO_ENCONTRADO'
            : status === HttpStatus.UNPROCESSABLE_ENTITY
              ? 'CANTIDAD_INVALIDA'
              : status === HttpStatus.CONFLICT
                ? 'CONFLICTO'
                : 'ERROR_HTTP';

      const body: ProblemDetailsBody = {
        type: `/errores/${code.toLowerCase().replace(/_/g, '-')}`,
        title: exception.name || 'Error',
        status,
        code,
        detail,
        correlationId: correlationIdHeader,
      };

      return response
        .status(status)
        .header('Content-Type', 'application/problem+json')
        .json(body);
    }

    const err = exception as Error;
    const body: ProblemDetailsBody = {
      type: '/errores/error-interno',
      title: 'Error interno del servidor',
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: 'ERROR_INTERNO',
      detail: err?.message || 'Error no controlado',
      correlationId: correlationIdHeader,
    };

    return response
      .status(HttpStatus.INTERNAL_SERVER_ERROR)
      .header('Content-Type', 'application/problem+json')
      .json(body);
  }
}
