import { afterEach, describe, expect, it, vi } from 'vitest';
import { OutboxPublisherService } from '../outbox/outbox-publisher.service.js';
import { ReservationExpirationService } from '../reservations/reservation-expiration.service.js';
import { InventoryWorkersService } from './inventory-workers.service.js';

describe('InventoryWorkersService', () => {
  afterEach(() => vi.useRealTimers());

  it('inicia la expiración y el despacho sin invocaciones manuales', async () => {
    vi.useFakeTimers();
    const expiration = {
      expirarReservasVencidas: vi.fn().mockResolvedValue({
        procesadas: 0,
        expiradas: 0,
        fallidas: 0,
      }),
    } as unknown as ReservationExpirationService;
    const outbox = {
      dispatchPending: vi
        .fn()
        .mockResolvedValue({ dispatched: 0, failed: 0, skipped: false }),
    } as unknown as OutboxPublisherService;
    const workers = new InventoryWorkersService(expiration, outbox);

    workers.onModuleInit();
    await vi.waitFor(() => {
      expect(expiration.expirarReservasVencidas).toHaveBeenCalledOnce();
      expect(outbox.dispatchPending).toHaveBeenCalledOnce();
    });

    await workers.onModuleDestroy();
  });
});
