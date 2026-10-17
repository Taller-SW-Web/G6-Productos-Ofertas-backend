import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ReintegrosService } from './reintegros.service.js';
import { IdempotencyService } from '../idempotency/idempotency.service.js';
import { KardexService } from '../kardex/kardex.service.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { DatabaseService } from '../database/database.service.js';
import { InMemoryDatabaseMock } from '../../test/in-memory-database.mock.js';
import { ReintegroInventarioRequest } from '../types/inventory.dto.js';

import { DrizzleStockBalanceRepository } from '../repositories/drizzle/drizzle-stock-balance.repository.js';
import { DrizzleOperationsRepository } from '../repositories/drizzle/drizzle-operations.repository.js';
import { DrizzleLocationsRepository } from '../repositories/drizzle/drizzle-locations.repository.js';
import { DrizzleKardexRepository } from '../repositories/drizzle/drizzle-kardex.repository.js';
import { DrizzleOutboxRepository } from '../repositories/drizzle/drizzle-outbox.repository.js';

describe('ReintegrosService — Reintegro F3/Postventa (SPEC-015 §24.1)', () => {
  let reintegrosService: ReintegrosService;
  let mockDb: InMemoryDatabaseMock;

  const locLurin = '9129b578-631e-1735-8427-b683fb524380';
  const locMiraflores = 'aea2f0d8-e8c6-b09c-8e7a-b4a3630bc485';
  const sku = 'NIK-REV7-NEG-41';

  function buildRequest(
    overrides: Partial<ReintegroInventarioRequest> = {},
  ): ReintegroInventarioRequest {
    return {
      operation_id: randomUUID(),
      order_id: 'PED-F3-0001',
      source_ref: 'DEV-0001',
      reason: 'DEVOLUCION_ACEPTADA',
      lines: [{ sku, quantity: 2, location_id: locLurin }],
      ...overrides,
    };
  }

  beforeEach(() => {
    mockDb = new InMemoryDatabaseMock();
    const dbService = new DatabaseService();
    dbService.setCustomService(mockDb);

    const idempotencyService = new IdempotencyService();
    const kardexService = new KardexService(
      new DrizzleKardexRepository(dbService),
    );
    const outboxService = new OutboxService(
      new DrizzleOutboxRepository(dbService),
    );

    reintegrosService = new ReintegrosService(
      dbService,
      idempotencyService,
      kardexService,
      outboxService,
      new DrizzleOperationsRepository(dbService),
      new DrizzleStockBalanceRepository(dbService),
      new DrizzleLocationsRepository(dbService),
    );
  });

  it('incrementa on_hand/available y responde 200 COMPLETED con Kardex y Outbox', async () => {
    const dto = buildRequest();

    const res = await reintegrosService.reintegrarInventario(
      dto,
      undefined,
      dto.operation_id,
      'modulo-postventa',
    );

    expect(res.status).toBe('COMPLETED');
    expect(res.operation_id).toBe(dto.operation_id);
    expect(res.order_id).toBe('PED-F3-0001');
    expect(res.source_ref).toBe('DEV-0001');
    expect(res.lines).toEqual([
      {
        sku,
        location_id: locLurin,
        quantity: 2,
        on_hand: 20,
        reserved: 0,
        blocked: 0,
        available: 20,
        stock_version: 2,
      },
    ]);

    const balance = mockDb.stockBalance.find(
      (row) => row.sku_id === sku && row.location_id === locLurin,
    )!;
    expect(balance.on_hand).toBe(20);
    expect(balance.available).toBe(20);
    expect(balance.stock_version).toBe(2);
    // El reintegro no altera reserved ni blocked.
    expect(balance.reserved).toBe(0);
    expect(balance.blocked).toBe(0);

    expect(mockDb.kardex).toHaveLength(1);
    expect(mockDb.kardex[0].operation_type).toBe('REINTEGRO');
    const outbox = mockDb.outbox.filter(
      (row) => row.event_type === 'inventory.stock.changed',
    );
    expect(outbox).toHaveLength(1);
  });

  it('un retry idéntico no duplica stock ni Kardex', async () => {
    const dto = buildRequest();
    const key = dto.operation_id;

    const first = await reintegrosService.reintegrarInventario(
      dto,
      undefined,
      key,
      'modulo-postventa',
    );
    const second = await reintegrosService.reintegrarInventario(
      dto,
      undefined,
      key,
      'modulo-postventa',
    );

    expect(second).toEqual(first);
    expect(mockDb.kardex).toHaveLength(1);
    expect(mockDb.operations).toHaveLength(1);
    const balance = mockDb.stockBalance.find(
      (row) => row.sku_id === sku && row.location_id === locLurin,
    )!;
    expect(balance.on_hand).toBe(20);
  });

  it('agrupa líneas repetidas del mismo (sku, location_id)', async () => {
    const dto = buildRequest({
      lines: [
        { sku, quantity: 1, location_id: locLurin },
        { sku, quantity: 2, location_id: locLurin },
      ],
    });

    const res = await reintegrosService.reintegrarInventario(
      dto,
      undefined,
      dto.operation_id,
      'modulo-postventa',
    );

    expect(res.lines).toHaveLength(1);
    expect(res.lines[0].quantity).toBe(3);
    expect(res.lines[0].on_hand).toBe(21);
    expect(mockDb.kardex).toHaveLength(1);
  });

  it('responde 409 si la Idempotency-Key se reutiliza con otro operation_id', async () => {
    const dto = buildRequest();
    const key = dto.operation_id;
    await reintegrosService.reintegrarInventario(
      dto,
      undefined,
      key,
      'modulo-postventa',
    );

    await expect(
      reintegrosService.reintegrarInventario(
        buildRequest({ operation_id: randomUUID() }),
        undefined,
        key,
        'modulo-postventa',
      ),
    ).rejects.toMatchObject({ problem: { code: 'IDEMPOTENCY_CONFLICT' } });
  });

  it('responde 409 si el operation_id se reutiliza con otro payload', async () => {
    const dto = buildRequest();
    await reintegrosService.reintegrarInventario(
      dto,
      undefined,
      dto.operation_id,
      'modulo-postventa',
    );

    await expect(
      reintegrosService.reintegrarInventario(
        buildRequest({ operation_id: dto.operation_id, source_ref: 'DEV-X' }),
        undefined,
        dto.operation_id,
        'modulo-postventa',
      ),
    ).rejects.toMatchObject({ problem: { code: 'IDEMPOTENCY_CONFLICT' } });
  });

  it('rechaza DEVOLUCION_ACEPTADA cuando no lo invoca modulo-postventa', async () => {
    const dto = buildRequest();

    await expect(
      reintegrosService.reintegrarInventario(
        dto,
        undefined,
        dto.operation_id,
        'modulo-ventas',
      ),
    ).rejects.toMatchObject({ problem: { code: 'REINTEGRO_NO_APLICABLE' } });

    // Sin efectos secundarios.
    expect(mockDb.kardex).toHaveLength(0);
    const balance = mockDb.stockBalance.find(
      (row) => row.sku_id === sku && row.location_id === locLurin,
    )!;
    expect(balance.on_hand).toBe(18);
  });

  it('admite a modulo-ventas para motivos distintos de F3', async () => {
    const dto = buildRequest({ reason: 'RETORNO_LOGISTICO' });

    const res = await reintegrosService.reintegrarInventario(
      dto,
      undefined,
      dto.operation_id,
      'modulo-ventas',
    );

    expect(res.status).toBe('COMPLETED');
    expect(mockDb.kardex).toHaveLength(1);
  });

  it('responde 422 UBICACION_NO_ENCONTRADA si la ubicación no está activa', async () => {
    const dto = buildRequest({
      lines: [{ sku, quantity: 1, location_id: randomUUID() }],
    });

    await expect(
      reintegrosService.reintegrarInventario(
        dto,
        undefined,
        dto.operation_id,
        'modulo-postventa',
      ),
    ).rejects.toMatchObject({ problem: { code: 'UBICACION_NO_ENCONTRADA' } });
  });

  it('responde 422 SKU_NO_ENCONTRADO si no existe saldo en la ubicación', async () => {
    const dto = buildRequest({
      lines: [{ sku: 'SKU-INEXISTENTE', quantity: 1, location_id: locLurin }],
    });

    await expect(
      reintegrosService.reintegrarInventario(
        dto,
        undefined,
        dto.operation_id,
        'modulo-postventa',
      ),
    ).rejects.toMatchObject({ problem: { code: 'SKU_NO_ENCONTRADO' } });
  });

  it('responde 422 CANTIDAD_INVALIDA con quantity no entera o no positiva', async () => {
    const dto = buildRequest({
      lines: [{ sku, quantity: 0, location_id: locLurin }],
    });

    await expect(
      reintegrosService.reintegrarInventario(
        dto,
        undefined,
        dto.operation_id,
        'modulo-postventa',
      ),
    ).rejects.toMatchObject({ problem: { code: 'CANTIDAD_INVALIDA' } });
  });

  it('responde 400 VALIDACION sin Idempotency-Key', async () => {
    await expect(
      reintegrosService.reintegrarInventario(
        buildRequest(),
        undefined,
        undefined,
        'modulo-postventa',
      ),
    ).rejects.toMatchObject({ problem: { code: 'VALIDACION' } });
  });

  it('permite reintegrar el mismo SKU en dos ubicaciones distintas', async () => {
    const dto = buildRequest({
      lines: [
        { sku, quantity: 1, location_id: locLurin },
        { sku, quantity: 2, location_id: locMiraflores },
      ],
    });

    const res = await reintegrosService.reintegrarInventario(
      dto,
      undefined,
      dto.operation_id,
      'modulo-postventa',
    );

    expect(res.lines).toHaveLength(2);
    expect(mockDb.kardex).toHaveLength(2);
  });
});
