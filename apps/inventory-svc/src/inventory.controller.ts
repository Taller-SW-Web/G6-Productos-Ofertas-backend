import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Query,
  Headers,
  Req,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { ReservationsService } from './reservations/reservations.service.js';
import { OperationsService } from './operations/operations.service.js';
import { DisponibilidadService } from './disponibilidad/disponibilidad.service.js';
import {
  CrearReservaRequest,
  OperacionReservaRequest,
  LiberarReservaRequest,
  OperacionInventarioAceptada,
  ConsultaOperacionInventario,
  ConsultaDisponibilidadResponse,
  VerificarCantidadComercialRequest,
  VerificarCantidadComercialResponse,
} from './types/inventory.dto.js';
import { ProblemDetailsException } from './errors/inventory.errors.js';
import { InventoryAuthGuard } from './auth/inventory-auth.guard.js';
import { RequireScope, AllowedClients } from './auth/auth.decorators.js';
import { INVENTORY_SCOPES, KNOWN_CLIENTS } from './auth/auth.constants.js';

@Controller('api/v1/inventario')
@UseGuards(InventoryAuthGuard)
export class InventoryController {
  constructor(
    private readonly reservationsService: ReservationsService,
    private readonly operationsService: OperationsService,
    private readonly disponibilidadService: DisponibilidadService,
  ) {}

  @Post('reservas')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequireScope(INVENTORY_SCOPES.RESERVAR)
  @AllowedClients([KNOWN_CLIENTS.VENTAS])
  async solicitarReserva(
    @Body() dto: CrearReservaRequest,
    @Req() req: any,
    @Headers('x-correlation-id') correlationId?: string,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<OperacionInventarioAceptada> {
    if (!idempotencyKey) {
      throw ProblemDetailsException.validation(
        'El encabezado Idempotency-Key es obligatorio para solicitar una reserva',
        correlationId,
      );
    }
    const clientId = req?.clientId;
    if (typeof clientId !== 'string' || clientId.trim().length === 0) {
      throw ProblemDetailsException.tokenInvalido(
        'El token verificado no contiene una identidad de cliente',
        correlationId,
      );
    }
    return this.reservationsService.solicitarReserva(
      dto,
      correlationId,
      idempotencyKey,
      clientId,
    );
  }

  @Post('reservas/:reservaId/confirmar')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequireScope(INVENTORY_SCOPES.CONSUMIR)
  @AllowedClients([KNOWN_CLIENTS.VENTAS])
  async confirmarReserva(
    @Param('reservaId') reservaId: string,
    @Body() dto: OperacionReservaRequest,
    @Req() req: any,
    @Headers('x-correlation-id') correlationId?: string,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<OperacionInventarioAceptada> {
    if (!idempotencyKey) {
      throw ProblemDetailsException.validation(
        'El encabezado Idempotency-Key es obligatorio para confirmar una reserva',
        correlationId,
      );
    }
    const clientId = req?.clientId;
    if (typeof clientId !== 'string' || clientId.trim().length === 0) {
      throw ProblemDetailsException.tokenInvalido(
        'El token verificado no contiene una identidad de cliente',
        correlationId,
      );
    }
    return this.reservationsService.confirmarReserva(
      reservaId,
      dto,
      correlationId,
      idempotencyKey,
      clientId,
    );
  }

  @Post('reservas/:reservaId/liberar')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequireScope(INVENTORY_SCOPES.LIBERAR)
  @AllowedClients([KNOWN_CLIENTS.VENTAS])
  async liberarReserva(
    @Param('reservaId') reservaId: string,
    @Body() dto: LiberarReservaRequest,
    @Req() req: any,
    @Headers('x-correlation-id') correlationId?: string,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<OperacionInventarioAceptada> {
    if (!idempotencyKey) {
      throw ProblemDetailsException.validation(
        'El encabezado Idempotency-Key es obligatorio para liberar una reserva',
        correlationId,
      );
    }
    const clientId = req?.clientId;
    if (typeof clientId !== 'string' || clientId.trim().length === 0) {
      throw ProblemDetailsException.tokenInvalido(
        'El token verificado no contiene una identidad de cliente',
        correlationId,
      );
    }
    return this.reservationsService.liberarReserva(
      reservaId,
      dto,
      correlationId,
      idempotencyKey,
      clientId,
    );
  }

  @Get('operaciones/:operationId')
  @RequireScope(INVENTORY_SCOPES.OPERACIONES_LEER)
  @AllowedClients([KNOWN_CLIENTS.VENTAS])
  async consultarOperacion(
    @Param('operationId') operationId: string,
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<ConsultaOperacionInventario> {
    return this.operationsService.consultarOperacion(
      operationId,
      correlationId,
    );
  }

  @Get('disponibilidad')
  @RequireScope(INVENTORY_SCOPES.DISPONIBILIDAD_LEER)
  @AllowedClients([KNOWN_CLIENTS.VENTAS])
  async consultarDisponibilidad(
    @Query('skus') skusQuery?: string | string[],
    @Query('location_id') locationId?: string,
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<ConsultaDisponibilidadResponse> {
    let skus: string[] = [];
    if (typeof skusQuery === 'string') {
      skus = skusQuery
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    } else if (Array.isArray(skusQuery)) {
      skus = skusQuery
        .flatMap((s) => s.split(','))
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    }

    if (skus.length === 0) {
      throw ProblemDetailsException.validation(
        'El parámetro de consulta skus es obligatorio (ej. ?skus=SKU-1,SKU-2)',
        correlationId,
      );
    }

    return this.disponibilidadService.consultarDisponibilidad(
      skus,
      locationId,
      correlationId,
    );
  }

  @Post('disponibilidad/comercial/verificar')
  @RequireScope(INVENTORY_SCOPES.DISPONIBILIDAD_LEER)
  @AllowedClients([
    KNOWN_CLIENTS.MARKETPLACE,
    KNOWN_CLIENTS.CHATBOT,
    KNOWN_CLIENTS.RETAIL,
  ])
  async verificarCantidadComercial(
    @Body() dto: VerificarCantidadComercialRequest,
    @Req() req: any,
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<VerificarCantidadComercialResponse> {
    const clientId = req?.clientId || req?.user?.client_id || req?.user?.sub;

    const channelClientMap: Record<string, string> = {
      MARKETPLACE: KNOWN_CLIENTS.MARKETPLACE,
      CHATBOT: KNOWN_CLIENTS.CHATBOT,
      RETAIL: KNOWN_CLIENTS.RETAIL,
    };

    if (!dto?.channel_id || channelClientMap[dto.channel_id] !== clientId) {
      throw ProblemDetailsException.scopeInsuficiente(
        `El canal '${dto?.channel_id ?? 'desconocido'}' no corresponde al cliente autenticado '${clientId}'`,
        correlationId,
      );
    }

    return this.disponibilidadService.verificarCantidadComercial(
      dto,
      correlationId,
    );
  }
}
