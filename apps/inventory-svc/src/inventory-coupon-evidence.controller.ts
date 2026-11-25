import {
  Controller,
  Get,
  Headers,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AllowedClients, RequireScope } from './auth/auth.decorators.js';
import { INVENTORY_SCOPES } from './auth/auth.constants.js';
import { InventoryAuthGuard } from './auth/inventory-auth.guard.js';
import { ReservationsService } from './reservations/reservations.service.js';
import type { ConsultaEstadoReservaResponse } from './types/inventory.dto.js';

@Controller('api/v1/interno/inventario')
@UseGuards(InventoryAuthGuard)
export class InventoryCouponEvidenceController {
  constructor(private readonly reservations: ReservationsService) {}

  @Get('reservas/:reservaId/evidencia-cupon')
  @RequireScope(INVENTORY_SCOPES.RESERVAS_ESTADO_LEER)
  @AllowedClients(['promotions-svc'])
  evidence(
    @Param('reservaId') reservationId: string,
    @Query('order_id') orderId: string,
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<ConsultaEstadoReservaResponse> {
    return this.reservations.consultarEstadoReserva(
      reservationId,
      orderId,
      correlationId,
    );
  }
}
