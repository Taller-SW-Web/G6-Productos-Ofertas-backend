import {
  Controller,
  Get,
  Inject,
  NotFoundException,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  CouponH5Operations,
  prepareCouponH5Admission,
  type CouponH5Kind,
} from '../coupons/coupon-h5-operations.js';
import { CouponH5Runtime } from '../coupons/coupon-h5-runtime.js';
import {
  correlationId,
  isUuid,
  PromotionsHttpError,
} from './http-validation.js';
import { PromotionsIdentity } from './promotions-identity.js';

const actor = 'modulo-ventas';
const scopes = {
  CONSUMIR_CUPON: 'cupones:consumir',
  RESTAURAR_CUPON: 'cupones:restaurar',
  CONSULTAR: 'cupones:operaciones:leer',
} as const;

const problemTitles: Record<string, string> = {
  VALIDACION: 'Datos de entrada inválidos',
  TOKEN_INVALIDO: 'Token ausente o inválido',
  SCOPE_INSUFICIENTE: 'Permisos insuficientes',
  IDEMPOTENCY_CONFLICT: 'La identidad ya corresponde a otra intención',
  OPERACION_CUPON_NO_ENCONTRADA: 'Operación de cupón no encontrada',
  SERVICIO_NO_DISPONIBLE: 'Servicio temporalmente no disponible',
  ERROR_INTERNO: 'Error interno',
};

function operationError(error: unknown): never {
  if (error instanceof Error) {
    if (['VALIDACION', 'INVALID_COUPON_COMMAND'].includes(error.message))
      throw new PromotionsHttpError(400, 'VALIDACION');
    if (error.message === 'IDEMPOTENCY_CONFLICT')
      throw new PromotionsHttpError(409, error.message);
    if (error.message === 'INVALID_COUPON_H5_SNAPSHOT')
      throw new PromotionsHttpError(500, 'ERROR_INTERNO');
  }
  throw new PromotionsHttpError(503, 'SERVICIO_NO_DISPONIBLE');
}

@Controller('api/v1/cupones')
export class CouponH5Controller {
  constructor(
    @Inject(PromotionsIdentity) private readonly identity: PromotionsIdentity,
    @Inject(CouponH5Operations)
    private readonly operations: Pick<CouponH5Operations, 'admit' | 'get'>,
    @Inject(CouponH5Runtime)
    private readonly runtime: Pick<
      CouponH5Runtime,
      'enabled' | 'assertAdmissionAvailable'
    >,
  ) {}

  @Post('consumos')
  consume(@Req() request: Request, @Res() response: Response) {
    return this.admit('CONSUMIR_CUPON', request, response);
  }

  @Post('restauraciones')
  restore(@Req() request: Request, @Res() response: Response) {
    return this.admit('RESTAURAR_CUPON', request, response);
  }

  @Get('operaciones/:operationId')
  find(@Req() request: Request, @Res() response: Response) {
    return this.authorized('CONSULTAR', request, response, async () => {
      const { operationId } = request.params;
      const orderId = request.query.order_id;
      if (
        !isUuid(operationId) ||
        typeof orderId !== 'string' ||
        !orderId.length
      )
        throw new PromotionsHttpError(400, 'VALIDACION');

      const snapshot = await this.operations
        .get(operationId.toLowerCase(), orderId, actor)
        .catch(operationError);
      if (!snapshot)
        throw new PromotionsHttpError(404, 'OPERACION_CUPON_NO_ENCONTRADA');
      response.status(200).json(snapshot);
    });
  }

  private admit(kind: CouponH5Kind, request: Request, response: Response) {
    return this.authorized(kind, request, response, async (id) => {
      const idempotencyKey = request.header('Idempotency-Key') ?? '';
      let admission;
      try {
        admission = prepareCouponH5Admission(
          kind,
          request.body,
          idempotencyKey,
          actor,
          id,
        );
      } catch (error) {
        operationError(error);
      }
      try {
        this.runtime.assertAdmissionAvailable();
      } catch (error) {
        operationError(error);
      }
      const result = await this.operations
        .admit(admission)
        .catch(operationError);
      if (result.replay) {
        response.status(200).json(result.snapshot);
        return;
      }
      const { operation_id, data } = admission.command;
      const query = new URLSearchParams({ order_id: data.order_id });
      response
        .set('Location', `/api/v1/cupones/operaciones/${operation_id}?${query}`)
        .set('Retry-After', '2')
        .status(202)
        .json(result.snapshot);
    });
  }

  private async authorized(
    action: keyof typeof scopes,
    request: Request,
    response: Response,
    handle: (id: string) => Promise<void>,
  ): Promise<void> {
    if (!this.runtime.enabled) throw new NotFoundException();
    const id = correlationId(request);
    response.set('X-Correlation-Id', id).set('Cache-Control', 'no-store');
    try {
      await this.identity.authorize(
        {
          security: ['serviceBearer'],
          audience: 'api-productos',
          scope: scopes[action],
          clients: [actor],
        },
        request.header('Authorization'),
      );
      await handle(id);
    } catch (error) {
      const problem =
        error instanceof PromotionsHttpError
          ? error
          : new PromotionsHttpError(500, 'ERROR_INTERNO');
      response
        .status(problem.status)
        .type('application/problem+json')
        .json({
          type: '/errores/' + problem.code.toLowerCase().replaceAll('_', '-'),
          title: problemTitles[problem.code] ?? 'Error',
          status: problem.status,
          code: problem.code,
          correlationId: id,
        });
    }
  }
}
