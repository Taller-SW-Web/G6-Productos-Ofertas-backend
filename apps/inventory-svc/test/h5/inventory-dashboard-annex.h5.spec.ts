import { describe, it, expect, beforeEach } from 'vitest';
import { DashboardService } from '../../src/dashboard/dashboard.service.js';
import { DatabaseService } from '../../src/database/database.service.js';
import { InMemoryDatabaseMock } from '../in-memory-database.mock.js';

describe('TAC-A04 — Anexos funcionales de lectura Dashboard / Alertas / Ubicaciones (sin exponer rutas nuevas)', () => {
  let service: DashboardService;
  let mockDb: InMemoryDatabaseMock;

  const locLurin = '9129b578-631e-1735-8427-b683fb524380';
  const locMiraflores = 'aea2f0d8-e8c6-b09c-8e7a-b4a3630bc485';
  const skuNik = 'NIK-REV7-NEG-41';
  const skuAdi = 'ADI-RF3-GRI-38';

  beforeEach(() => {
    mockDb = new InMemoryDatabaseMock();
    const dbService = new DatabaseService();
    dbService.setCustomService(mockDb);
    service = new DashboardService(dbService);
  });

  it('clasifica available = 0 -> AGOTADO, 0 < available <= umbral -> STOCK_BAJO, available > umbral -> DISPONIBLE', async () => {
    mockDb.thresholdOverrides = [
      { id: 't-global', sku_id: null, location_id: null, umbral_efectivo: 5 },
    ];
    mockDb.stockBalance = [
      {
        sku_id: 'SYN-AGOTADO',
        location_id: locLurin,
        on_hand: 3,
        reserved: 3,
        blocked: 0,
        available: 0,
        stock_version: 1,
      },
      {
        sku_id: 'SYN-BAJO-EXACTO',
        location_id: locLurin,
        on_hand: 5,
        reserved: 0,
        blocked: 0,
        available: 5,
        stock_version: 1,
      },
      {
        sku_id: 'SYN-DISPONIBLE',
        location_id: locLurin,
        on_hand: 6,
        reserved: 0,
        blocked: 0,
        available: 6,
        stock_version: 1,
      },
    ];

    const saldos = await service.listarSaldosFisicos({ locationId: locLurin });
    const bySku = new Map(saldos.items.map((item) => [item.sku, item]));

    expect(bySku.get('SYN-AGOTADO')?.estado).toBe('AGOTADO');
    expect(bySku.get('SYN-AGOTADO')?.available).toBe(0);
    expect(bySku.get('SYN-BAJO-EXACTO')?.estado).toBe('STOCK_BAJO');
    expect(bySku.get('SYN-BAJO-EXACTO')?.available).toBe(5);
    expect(bySku.get('SYN-DISPONIBLE')?.estado).toBe('DISPONIBLE');
    expect(bySku.get('SYN-DISPONIBLE')?.available).toBe(6);

    const alertas = await service.obtenerAlertasInternas({
      locationId: locLurin,
    });
    expect(alertas.items.map((a) => a.sku).sort()).toEqual([
      'SYN-AGOTADO',
      'SYN-BAJO-EXACTO',
    ]);
  });

  it('SKU sin saldo observado retorna vacío/indeterminado y nunca se fabrica como AGOTADO ni DISPONIBLE', async () => {
    const saldos = await service.listarSaldosFisicos({
      sku: 'SYN-UNREG-NO-STOCK',
    });
    expect(saldos.items).toEqual([]);
    expect(saldos.meta.total).toBe(0);

    const alertas = await service.obtenerAlertasInternas({
      sku: 'SYN-UNREG-NO-STOCK',
    });
    expect(alertas.items).toEqual([]);
    expect(alertas.meta.total).toBe(0);
  });

  it('excluye ubicaciones inactivas de alertas operativas pero conserva ubicaciones sin stock en el listado de ubicaciones', async () => {
    const emptyLocId = '44444444-4444-4444-8444-444444444444';
    mockDb.locations.push({
      id: emptyLocId,
      code: 'ALM-SIN-STOCK',
      name: 'Almacén Sin Stock',
      type: 'ALMACEN',
      active: true,
    });
    const miraflores = mockDb.locations.find((l) => l.id === locMiraflores)!;
    miraflores.active = false;

    // Miraflores inactiva no genera alertas ni saldos cuando está desactivada
    const alertasMiraflores = await service.obtenerAlertasInternas({
      locationId: locMiraflores,
    });
    expect(alertasMiraflores.items).toHaveLength(0);

    // Ubicación sin stock sigue existiendo en listado autoritativo de ubicaciones
    const ubicacionesActivas = await service.obtenerUbicacionesInternas({
      soloActivas: true,
    });
    expect(ubicacionesActivas.items.map((u) => u.id)).toContain(emptyLocId);
    expect(ubicacionesActivas.items.map((u) => u.id)).not.toContain(
      locMiraflores,
    );

    // Con soloActivas=false (o ausente), devuelve todas incluyendo inactiva y vacía
    const todasUbicaciones = await service.obtenerUbicacionesInternas({
      soloActivas: false,
    });
    expect(todasUbicaciones.items.map((u) => u.id)).toContain(emptyLocId);
    expect(todasUbicaciones.items.map((u) => u.id)).toContain(locMiraflores);
    expect(todasUbicaciones.items.map((u) => u.id)).toContain(locLurin);
  });

  it('dashboard agregado reconcilia totales físicos exactamente contra los saldos filtrados', async () => {
    const dashboard = await service.obtenerDashboard({ sku: skuNik });
    const dashboardAdi = await service.obtenerDashboard({ sku: skuAdi });

    expect(dashboard.totalSkus).toBe(1);
    expect(dashboard.totalOnHand).toBe(22); // 18 + 4
    expect(dashboard.totalAvailable).toBe(22);

    expect(dashboardAdi.totalSkus).toBe(1);
    expect(dashboardAdi.totalOnHand).toBe(10);
  });
});
