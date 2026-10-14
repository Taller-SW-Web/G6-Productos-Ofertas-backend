import { HttpException, HttpStatus } from '@nestjs/common';

export interface ProblemDetailsBody {
  type: string;
  title: string;
  status: number;
  code: string;
  detail?: string;
  correlationId?: string;
}

export class ProblemDetailsException extends HttpException {
  public readonly problem: ProblemDetailsBody;

  constructor(problem: ProblemDetailsBody) {
    super(problem, problem.status);
    this.problem = problem;
  }

  static validation(
    detail?: string,
    correlationId?: string,
  ): ProblemDetailsException {
    return new ProblemDetailsException({
      type: '/errores/validacion',
      title: 'Datos de entrada inválidos',
      status: HttpStatus.BAD_REQUEST,
      code: 'VALIDACION',
      detail,
      correlationId,
    });
  }

  static cantidadInvalida(
    detail?: string,
    correlationId?: string,
  ): ProblemDetailsException {
    return new ProblemDetailsException({
      type: '/errores/cantidad-invalida',
      title: 'Cantidad inválida',
      status: HttpStatus.UNPROCESSABLE_ENTITY,
      code: 'CANTIDAD_INVALIDA',
      detail,
      correlationId,
    });
  }

  static idempotencyConflict(
    detail?: string,
    correlationId?: string,
  ): ProblemDetailsException {
    return new ProblemDetailsException({
      type: '/errores/idempotency-conflict',
      title: 'Conflicto de idempotencia',
      status: HttpStatus.CONFLICT,
      code: 'IDEMPOTENCY_CONFLICT',
      detail,
      correlationId,
    });
  }

  static reservaNoEncontrada(
    detail?: string,
    correlationId?: string,
  ): ProblemDetailsException {
    return new ProblemDetailsException({
      type: '/errores/reserva-no-encontrada',
      title: 'Reserva no encontrada',
      status: HttpStatus.NOT_FOUND,
      code: 'RESERVA_NO_ENCONTRADA',
      detail,
      correlationId,
    });
  }

  static reservaNoActiva(
    detail?: string,
    correlationId?: string,
  ): ProblemDetailsException {
    return new ProblemDetailsException({
      type: '/errores/reserva-no-activa',
      title: 'Reserva no activa',
      status: HttpStatus.CONFLICT,
      code: 'RESERVA_NO_ACTIVA',
      detail,
      correlationId,
    });
  }

  static reservaExpirada(
    detail?: string,
    correlationId?: string,
  ): ProblemDetailsException {
    return new ProblemDetailsException({
      type: '/errores/reserva-expirada',
      title: 'Reserva expirada',
      status: HttpStatus.CONFLICT,
      code: 'RESERVA_EXPIRADA',
      detail,
      correlationId,
    });
  }

  static tokenInvalido(
    detail?: string,
    correlationId?: string,
  ): ProblemDetailsException {
    return new ProblemDetailsException({
      type: '/errores/token-invalido',
      title: 'Token de autenticación ausente o inválido',
      status: HttpStatus.UNAUTHORIZED,
      code: 'TOKEN_INVALIDO',
      detail,
      correlationId,
    });
  }

  static scopeInsuficiente(
    detail?: string,
    correlationId?: string,
  ): ProblemDetailsException {
    return new ProblemDetailsException({
      type: '/errores/scope-insuficiente',
      title: 'Scope o client_id no autorizado',
      status: HttpStatus.FORBIDDEN,
      code: 'SCOPE_INSUFICIENTE',
      detail,
      correlationId,
    });
  }

  static operacionNoEncontrada(
    detail?: string,
    correlationId?: string,
  ): ProblemDetailsException {
    return new ProblemDetailsException({
      type: '/errores/operacion-no-encontrada',
      title: 'Operación de inventario no encontrada',
      status: HttpStatus.NOT_FOUND,
      code: 'OPERACION_INVENTARIO_NO_ENCONTRADA',
      detail,
      correlationId,
    });
  }

  static contextoAbastecimientoInvalido(
    detail?: string,
    correlationId?: string,
  ): ProblemDetailsException {
    return new ProblemDetailsException({
      type: '/errores/contexto-abastecimiento-invalido',
      title:
        'Contexto de abastecimiento o cumplimiento semánticamente inválido',
      status: HttpStatus.UNPROCESSABLE_ENTITY,
      code: 'CONTEXTO_ABASTECIMIENTO_INVALIDO',
      detail,
      correlationId,
    });
  }
}
