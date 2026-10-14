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
import { OperationsService } from './operations/operations.service.js';
import { DisponibilidadService } from './disponibilidad/disponibilidad.service.js';

import { DrizzleLocationsRepository } from './repositories/drizzle/drizzle-locations.repository.js';
import { DrizzleCommercialRoutesRepository } from './repositories/drizzle/drizzle-commercial-routes.repository.js';
import { DrizzleStockBalanceRepository } from './repositories/drizzle/drizzle-stock-balance.repository.js';
import { DrizzleReservationsRepository } from './repositories/drizzle/drizzle-reservations.repository.js';
import { DrizzleOperationsRepository } from './repositories/drizzle/drizzle-operations.repository.js';
import { DrizzleKardexRepository } from './repositories/drizzle/drizzle-kardex.repository.js';
import { DrizzleOutboxRepository } from './repositories/drizzle/drizzle-outbox.repository.js';

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
    OperationsService,
    DisponibilidadService,
    // Repositorios Drizzle
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
    OperationsService,
    DisponibilidadService,
    // Repositorios Drizzle
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
