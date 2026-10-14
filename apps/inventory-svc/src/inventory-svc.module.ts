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
  ],
})
export class InventorySvcModule {}
