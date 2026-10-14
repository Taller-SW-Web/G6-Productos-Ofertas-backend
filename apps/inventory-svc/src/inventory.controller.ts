import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Query,
  Headers,
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
  @AllowedClients([
    KNOWN_CLIENTS.VENTAS,
    KNOWN_CLIENTS.MARKETPLACE,
    KNOWN_CLIENTS.CHATBOT,
    KNOWN_CLIENTS.RETAIL,
  ])
  async solicitarReserva(
    @Body() dto: CrearReservaRequest,
    @Headers('x-correlation-id') correlationId?: string,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<OperacionInventarioAceptada> {
    return this.reservationsService.solicitarReserva(
      dto,
      correlationId,
      idempotencyKey,
    );
  }

  @Post('reservas/:reservaId/confirmar')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequireScope(INVENTORY_SCOPES.CONSUMIR)
  @AllowedClients([
    KNOWN_CLIENTS.VENTAS,
    KNOWN_CLIENTS.MARKETPLACE,
    KNOWN_CLIENTS.CHATBOT,
    KNOWN_CLIENTS.RETAIL,
  ])
  async confirmarReserva(
    @Param('reservaId') reservaId: string,
    @Body() dto: OperacionReservaRequest,
    @Headers('x-correlation-id') correlationId?: string,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<OperacionInventarioAceptada> {
    return this.reservationsService.confirmarReserva(
      reservaId,
      dto,
      correlationId,
      idempotencyKey,
    );
  }

  @Post('reservas/:reservaId/liberar')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequireScope(INVENTORY_SCOPES.LIBERAR)
  @AllowedClients([
    KNOWN_CLIENTS.VENTAS,
    KNOWN_CLIENTS.MARKETPLACE,
    KNOWN_CLIENTS.CHATBOT,
    KNOWN_CLIENTS.RETAIL,
  ])
  async liberarReserva(
    @Param('reservaId') reservaId: string,
    @Body() dto: LiberarReservaRequest,
    @Headers('x-correlation-id') correlationId?: string,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<OperacionInventarioAceptada> {
    return this.reservationsService.liberarReserva(
      reservaId,
      dto,
      correlationId,
      idempotencyKey,
    );
  }

  @Get('operaciones/:operationId')
  @RequireScope(INVENTORY_SCOPES.OPERACIONES_LEER)
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
  async verificarCantidadComercial(
    @Body() dto: VerificarCantidadComercialRequest,
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<VerificarCantidadComercialResponse> {
    return this.disponibilidadService.verificarCantidadComercial(
      dto,
      correlationId,
    );
  }
}
