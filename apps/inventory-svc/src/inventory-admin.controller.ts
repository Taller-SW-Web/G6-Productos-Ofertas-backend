import {
  Controller,
  Get,
  Put,
  Delete,
  Body,
  Param,
  Query,
  Headers,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { UmbralesService } from './umbrales/umbrales.service.js';
import { DashboardService } from './dashboard/dashboard.service.js';
import {
  DashboardInventario,
  UmbralGlobalRequest,
  UmbralInventario,
  UmbralSkuRequest,
} from './types/inventory.dto.js';
import { UserAuthGuard } from './auth/user-auth.guard.js';

/**
 * Endpoints `userBearer` (operador humano) del bounded context de Inventario:
 * administración de umbrales y dashboard read-only.
 */
@Controller('api/v1/inventario')
@UseGuards(UserAuthGuard)
export class InventoryAdminController {
  constructor(
    private readonly umbralesService: UmbralesService,
    private readonly dashboardService: DashboardService,
  ) {}

  @Get('umbrales')
  async obtenerUmbrales(
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<UmbralInventario> {
    return this.umbralesService.obtenerUmbrales(correlationId);
  }

  @Put('umbrales/global')
  @HttpCode(HttpStatus.OK)
  async actualizarUmbralGlobal(
    @Body() dto: UmbralGlobalRequest,
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<UmbralInventario> {
    return this.umbralesService.actualizarUmbralGlobal(
      dto?.umbral,
      correlationId,
    );
  }

  @Put('umbrales/skus/:sku')
  @HttpCode(HttpStatus.OK)
  async establecerUmbralSku(
    @Param('sku') sku: string,
    @Body() dto: UmbralSkuRequest,
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<UmbralInventario> {
    return this.umbralesService.establecerUmbralSku(
      sku,
      dto?.umbral,
      correlationId,
    );
  }

  @Delete('umbrales/skus/:sku')
  @HttpCode(HttpStatus.NO_CONTENT)
  async eliminarUmbralSku(
    @Param('sku') sku: string,
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<void> {
    return this.umbralesService.eliminarUmbralSku(sku, correlationId);
  }

  @Get('dashboard')
  async obtenerDashboard(
    @Query('productoId') productoId?: string,
    @Query('categoriaId') categoriaId?: string,
    @Query('marcaId') marcaId?: string,
    @Query('sku') sku?: string,
    @Query('locationId') locationId?: string,
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<DashboardInventario> {
    return this.dashboardService.obtenerDashboard(
      { productoId, categoriaId, marcaId, sku, locationId },
      correlationId,
    );
  }
}
