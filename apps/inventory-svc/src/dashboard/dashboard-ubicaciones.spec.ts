import { describe, it, expect, beforeEach } from 'vitest';
import { DashboardService } from './dashboard.service.js';
import { DatabaseService } from '../database/database.service.js';
import { InMemoryDatabaseMock } from '../../test/in-memory-database.mock.js';

describe('DashboardService — Lectura interna de ubicaciones (Extensión H02 / INV-B07)', () => {
  let service: DashboardService;
  let mockDb: InMemoryDatabaseMock;

  const locLurin = '9129b578-631e-1735-8427-b683fb524380';
  const locMiraflores = 'aea2f0d8-e8c6-b09c-8e7a-b4a3630bc485';

  beforeEach(() => {
    mockDb = new InMemoryDatabaseMock();
    const dbService = new DatabaseService();
    dbService.setCustomService(mockDb);
    service = new DashboardService(dbService);
  });

  it('devuelve las ubicaciones autoritativas reales del esquema inventory.locations', async () => {
    const res = await service.obtenerUbicacionesInternas();

    expect(res.total).toBe(2);
    expect(res.items).toHaveLength(2);

    const lurin = res.items.find((u) => u.id === locLurin)!;
    expect(lurin).toBeDefined();
    expect(lurin.code).toBe('ALM-LURIN');
    expect(lurin.name).toBe('Centro de distribución Lurín');
    expect(lurin.type).toBe('ALMACEN_CENTRAL');
    expect(lurin.active).toBe(true);

    const miraflores = res.items.find((u) => u.id === locMiraflores)!;
    expect(miraflores).toBeDefined();
    expect(miraflores.code).toBe('TDA-MIRAFLORES');
    expect(miraflores.name).toBe('Tienda Miraflores');
    expect(miraflores.type).toBe('TIENDA');
    expect(miraflores.active).toBe(true);
  });

  it('permite filtrar por soloActivas (true / false)', async () => {
    // Desactivamos Lurín
    const lurin = mockDb.locations.find((l) => l.id === locLurin)!;
    lurin.active = false;

    const activas = await service.obtenerUbicacionesInternas({
      soloActivas: true,
    });
    expect(activas.items).toHaveLength(1);
    expect(activas.items[0].id).toBe(locMiraflores);

    const inactivas = await service.obtenerUbicacionesInternas({
      soloActivas: false,
    });
    expect(inactivas.items).toHaveLength(1);
    expect(inactivas.items[0].id).toBe(locLurin);

    const todas = await service.obtenerUbicacionesInternas({});
    expect(todas.items).toHaveLength(2);
  });

  it('devuelve una ubicación válida aunque no posea registros de stock asociados', async () => {
    // Agregamos una nueva ubicación real sin stock
    const nuevaLocId = '33333333-3333-4333-8333-333333333333';
    mockDb.locations.push({
      id: nuevaLocId,
      code: 'ALM-TRUJILLO',
      name: 'Almacén Trujillo',
      type: 'ALMACEN_REGIONAL',
      active: true,
    });

    const res = await service.obtenerUbicacionesInternas();
    expect(res.total).toBe(3);
    const trujillo = res.items.find((u) => u.id === nuevaLocId);
    expect(trujillo).toBeDefined();
    expect(trujillo?.name).toBe('Almacén Trujillo');
  });

  it('ordena de forma determinista por code ASC, name ASC', async () => {
    const res = await service.obtenerUbicacionesInternas();
    expect(res.items[0].code).toBe('ALM-LURIN');
    expect(res.items[1].code).toBe('TDA-MIRAFLORES');
  });
});
