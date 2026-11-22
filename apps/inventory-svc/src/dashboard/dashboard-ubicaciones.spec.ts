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

  it('devuelve las ubicaciones autoritativas reales del esquema inventory.locations con paginación por defecto', async () => {
    const res = await service.obtenerUbicacionesInternas();

    expect(res.meta.total).toBe(2);
    expect(res.meta.pagina).toBe(1);
    expect(res.meta.tamanio).toBe(20);
    expect(res.meta.totalPaginas).toBe(1);
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

  it('respeta la semántica corregida de soloActivas: true = solo activas, false o ausente = todas', async () => {
    // Desactivamos Lurín
    const lurin = mockDb.locations.find((l) => l.id === locLurin)!;
    lurin.active = false;

    // Escenario 1: soloActivas = true -> solo activas (Miraflores)
    const activas = await service.obtenerUbicacionesInternas({
      soloActivas: true,
    });
    expect(activas.items).toHaveLength(1);
    expect(activas.items[0].id).toBe(locMiraflores);
    expect(activas.meta.total).toBe(1);

    // Escenario 2: soloActivas = false -> todas las ubicaciones (activas e inactivas)
    const todasConFalse = await service.obtenerUbicacionesInternas({
      soloActivas: false,
    });
    expect(todasConFalse.items).toHaveLength(2);
    expect(todasConFalse.meta.total).toBe(2);
    expect(todasConFalse.items.map((i) => i.id)).toContain(locLurin);
    expect(todasConFalse.items.map((i) => i.id)).toContain(locMiraflores);

    // Escenario 3: soloActivas ausente ({}) -> todas las ubicaciones
    const todasAusente = await service.obtenerUbicacionesInternas({});
    expect(todasAusente.items).toHaveLength(2);
    expect(todasAusente.meta.total).toBe(2);
  });

  it('soporta paginación server-side con pagina y tamanio determinista', async () => {
    const pag1 = await service.obtenerUbicacionesInternas({
      pagina: 1,
      tamanio: 1,
    });
    expect(pag1.items).toHaveLength(1);
    expect(pag1.items[0].code).toBe('ALM-LURIN');
    expect(pag1.meta.pagina).toBe(1);
    expect(pag1.meta.tamanio).toBe(1);
    expect(pag1.meta.total).toBe(2);
    expect(pag1.meta.totalPaginas).toBe(2);

    const pag2 = await service.obtenerUbicacionesInternas({
      pagina: 2,
      tamanio: 1,
    });
    expect(pag2.items).toHaveLength(1);
    expect(pag2.items[0].code).toBe('TDA-MIRAFLORES');
    expect(pag2.meta.pagina).toBe(2);
    expect(pag2.meta.tamanio).toBe(1);
    expect(pag2.meta.total).toBe(2);
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
    expect(res.meta.total).toBe(3);
    const trujillo = res.items.find((u) => u.id === nuevaLocId);
    expect(trujillo).toBeDefined();
    expect(trujillo?.name).toBe('Almacén Trujillo');
  });

  it('ordena de forma determinista por code ASC, name ASC, id ASC', async () => {
    const res = await service.obtenerUbicacionesInternas();
    expect(res.items[0].code).toBe('ALM-LURIN');
    expect(res.items[1].code).toBe('TDA-MIRAFLORES');
  });

  it('rechaza parámetros inválidos con 400 VALIDACION', async () => {
    await expect(
      service.obtenerUbicacionesInternas({ pagina: 0 }),
    ).rejects.toMatchObject({
      problem: { status: 400, code: 'VALIDACION' },
    });

    await expect(
      service.obtenerUbicacionesInternas({ tamanio: 101 }), // excede max 100
    ).rejects.toMatchObject({
      problem: { status: 400, code: 'VALIDACION' },
    });

    await expect(
      service.obtenerUbicacionesInternas({ filtroAjeno: 'xyz' } as any),
    ).rejects.toMatchObject({
      problem: { status: 400, code: 'VALIDACION' },
    });

    await expect(
      service.obtenerUbicacionesInternas({
        soloActivas: 'cualquierCosa' as any,
      }),
    ).rejects.toMatchObject({
      problem: { status: 400, code: 'VALIDACION' },
    });
  });
});
