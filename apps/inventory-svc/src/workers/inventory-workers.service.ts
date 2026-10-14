import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { loadInventoryConfig } from '../config/inventory.config.js';
import { OutboxPublisherService } from '../outbox/outbox-publisher.service.js';
import { ReservationExpirationService } from '../reservations/reservation-expiration.service.js';

@Injectable()
export class InventoryWorkersService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(InventoryWorkersService.name);
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private stopping = false;

  constructor(
    private readonly expiration: ReservationExpirationService,
    private readonly outbox: OutboxPublisherService,
  ) {}

  onModuleInit(): void {
    const config = loadInventoryConfig();
    this.timer = setInterval(
      () => void this.runOnce(config.workerBatchSize),
      config.workerIntervalMs,
    );
    this.timer.unref();
    void this.runOnce(config.workerBatchSize);
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    while (this.running) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  private async runOnce(batchSize: number): Promise<void> {
    if (this.running || this.stopping) return;
    this.running = true;
    try {
      await this.expiration.expirarReservasVencidas(batchSize);
      await this.outbox.dispatchPending(batchSize);
    } catch (error) {
      this.logger.error(
        `Fallo controlado en worker de Inventario: ${(error as Error).message}`,
      );
    } finally {
      this.running = false;
    }
  }
}
