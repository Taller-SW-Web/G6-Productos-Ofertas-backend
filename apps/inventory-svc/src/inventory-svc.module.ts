import { Module } from '@nestjs/common';
import { InventorySvcController } from './inventory-svc.controller.js';
import { InventoryController } from './inventory.controller.js';
import { InventorySvcService } from './inventory-svc.service.js';
import { DatabaseService } from './database/database.service.js';
import { IdempotencyService } from './idempotency/idempotency.service.js';
import { KardexService } from './kardex/kardex.service.js';
import { OutboxService } from './outbox/outbox.service.js';
import { OutboxPublisherService } from './outbox/outbox-publisher.service.js';
import { ReservationsService } from './reservations/reservations.service.js';
import { ReservationExpirationService } from './reservations/reservation-expiration.service.js';
import { OperationsService } from './operations/operations.service.js';
import { DisponibilidadService } from './disponibilidad/disponibilidad.service.js';

import { DrizzleLocationsRepository } from './repositories/drizzle/drizzle-locations.repository.js';
import { DrizzleCommercialRoutesRepository } from './repositories/drizzle/drizzle-commercial-routes.repository.js';
import { DrizzleStockBalanceRepository } from './repositories/drizzle/drizzle-stock-balance.repository.js';
import { DrizzleReservationsRepository } from './repositories/drizzle/drizzle-reservations.repository.js';
import { DrizzleOperationsRepository } from './repositories/drizzle/drizzle-operations.repository.js';
import { DrizzleKardexRepository } from './repositories/drizzle/drizzle-kardex.repository.js';
import { DrizzleOutboxRepository } from './repositories/drizzle/drizzle-outbox.repository.js';

import {
  LOCATIONS_REPOSITORY,
  COMMERCIAL_ROUTES_REPOSITORY,
  STOCK_BALANCE_REPOSITORY,
  RESERVATIONS_REPOSITORY,
  OPERATIONS_REPOSITORY,
  KARDEX_REPOSITORY,
  OUTBOX_REPOSITORY,
} from './repositories/interfaces/repository.tokens.js';

import { InventoryAuthGuard } from './auth/inventory-auth.guard.js';

@Module({
  imports: [],
  controllers: [InventorySvcController, InventoryController],
  providers: [
    InventorySvcService,
    DatabaseService,
    IdempotencyService,
    KardexService,
    OutboxService,
    OutboxPublisherService,
    ReservationsService,
    ReservationExpirationService,
    OperationsService,
    DisponibilidadService,
    InventoryAuthGuard,
    // Repositorios Drizzle vinculados a sus tokens de interfaz
    {
      provide: LOCATIONS_REPOSITORY,
      useClass: DrizzleLocationsRepository,
    },
    {
      provide: COMMERCIAL_ROUTES_REPOSITORY,
      useClass: DrizzleCommercialRoutesRepository,
    },
    {
      provide: STOCK_BALANCE_REPOSITORY,
      useClass: DrizzleStockBalanceRepository,
    },
    {
      provide: RESERVATIONS_REPOSITORY,
      useClass: DrizzleReservationsRepository,
    },
    {
      provide: OPERATIONS_REPOSITORY,
      useClass: DrizzleOperationsRepository,
    },
    {
      provide: KARDEX_REPOSITORY,
      useClass: DrizzleKardexRepository,
    },
    {
      provide: OUTBOX_REPOSITORY,
      useClass: DrizzleOutboxRepository,
    },
    // Compatibilidad directa de clases
    DrizzleLocationsRepository,
    DrizzleCommercialRoutesRepository,
    DrizzleStockBalanceRepository,
    DrizzleReservationsRepository,
    DrizzleOperationsRepository,
    DrizzleKardexRepository,
    DrizzleOutboxRepository,
  ],
  exports: [
    DatabaseService,
    IdempotencyService,
    KardexService,
    OutboxService,
    OutboxPublisherService,
    ReservationsService,
    ReservationExpirationService,
    OperationsService,
    DisponibilidadService,
    InventoryAuthGuard,
    LOCATIONS_REPOSITORY,
    COMMERCIAL_ROUTES_REPOSITORY,
    STOCK_BALANCE_REPOSITORY,
    RESERVATIONS_REPOSITORY,
    OPERATIONS_REPOSITORY,
    KARDEX_REPOSITORY,
    OUTBOX_REPOSITORY,
    DrizzleLocationsRepository,
    DrizzleCommercialRoutesRepository,
    DrizzleStockBalanceRepository,
    DrizzleReservationsRepository,
    DrizzleOperationsRepository,
    DrizzleKardexRepository,
    DrizzleOutboxRepository,
  ],
})
export class InventorySvcModule {}
