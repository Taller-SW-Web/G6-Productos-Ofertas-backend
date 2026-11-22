import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DashboardService } from './dashboard.service.js';
import { DatabaseService } from '../database/database.service.js';
import { InMemoryDatabaseMock } from '../../test/in-memory-database.mock.js';

describe('DashboardService — indicadores y distribución (SPEC-016)', () => {
  let service: DashboardService;
  let mockDb: InMemoryDatabaseMock;

  const locLurin = '9129b578-631e-1735-8427-b683fb524380';
  const locMiraflores = 'aea2f0d8-e8c6-b09c-8e7a-b4a3630bc485';
  const skuNik = 'NIK-REV7-NEG-41';

  beforeEach(() => {
    mockDb = new InMemoryDatabaseMock();
    const dbService = new DatabaseService();
    dbService.setCustomService(mockDb);
    service = new DashboardService(dbService);
  });

  it('calcula totales, estados por SKU y distribución por ubicación', async () => {
    const res = await service.obtenerDashboard({});

    expect(res.totalSkus).toBe(3);
    expect(res.totalOnHand).toBe(34);
    expect(res.totalReserved).toBe(0);
    expect(res.totalAvailable).toBe(34);
    expect(res.skusDisponibles).toBe(2);
    expect(res.skusStockBajo).toBe(1);
    expect(res.skusAgotados).toBe(0);

    const lurin = res.porUbicacion.find((u) => u.location_id === locLurin)!;
    expect(lurin.on_hand).toBe(30);
    expect(lurin.available).toBe(30);
    expect(lurin.skusDisponibles).toBe(2);
    expect(lurin.skusStockBajo).toBe(1);

    const miraflores = res.porUbicacion.find(
      (u) => u.location_id === locMiraflores,
    )!;
    expect(miraflores.on_hand).toBe(4);
    expect(miraflores.skusStockBajo).toBe(1);
  });

  it('pide al repositorio agregado solo totales y filas por ubicación', async () => {
    const querySpy = vi.spyOn(mockDb, 'query');

    const res = await service.obtenerDashboard({});

    const dashboardQueries = querySpy.mock.calls.filter(([sql]) =>
      sql.includes('filtered_balance AS MATERIALIZED'),
    );
    expect(dashboardQueries).toHaveLength(1);
    expect(dashboardQueries[0]?.[0]).toContain('GROUP BY sku_id');
    expect(dashboardQueries[0]?.[0]).toContain('GROUP BY location_id');
    expect(dashboardQueries[0]?.[0]).toContain('SELECT DISTINCT ON (sku_id)');
    expect(dashboardQueries[0]?.[0]).toContain(
      'ORDER BY sku_id, updated_at DESC, created_at DESC, id DESC',
    );
    expect(res.porUbicacion).toHaveLength(2);
  });

  it('las métricas internas reutilizan el agregado sin volver a leer saldos', async () => {
    const querySpy = vi.spyOn(mockDb, 'query');

    await service.obtenerMetricasInternas();

    expect(
      querySpy.mock.calls.filter(([sql]) =>
        sql.includes('filtered_balance AS MATERIALIZED'),
      ),
    ).toHaveLength(1);
    expect(
      querySpy.mock.calls.filter(([sql]) =>
        sql.includes('FROM inventory.traslados'),
      ),
    ).toHaveLength(1);
    expect(querySpy).toHaveBeenCalledTimes(2);
  });

  it('mantiene el filtro SKU vacío como ausencia de filtro', async () => {
    const all = await service.obtenerDashboard({});
    const emptySku = await service.obtenerDashboard({ sku: '' });

    expect(emptySku.totalSkus).toBe(all.totalSkus);
    expect(emptySku.totalAvailable).toBe(all.totalAvailable);
  });

  it('filtra por SKU', async () => {
    const res = await service.obtenerDashboard({ sku: skuNik });
    expect(res.totalSkus).toBe(1);
    expect(res.totalAvailable).toBe(22);
    expect(res.skusDisponibles).toBe(1);
  });

  it('filtra por ubicación', async () => {
    const res = await service.obtenerDashboard({ locationId: locLurin });
    expect(res.totalSkus).toBe(3);
    expect(res.totalAvailable).toBe(30);
    expect(res.porUbicacion).toHaveLength(1);
  });

  it('aplica el umbral global a la clasificación', async () => {
    mockDb.thresholdOverrides = [
      { id: 't-global', sku_id: null, location_id: null, umbral_efectivo: 30 },
    ];
    const res = await service.obtenerDashboard({});
    expect(res.skusDisponibles).toBe(0);
    expect(res.skusStockBajo).toBe(3);
  });

  it('calcula los indicadores SPEC-016 internos sin ampliar el DTO HTTP vigente', async () => {
    mockDb.stockBalance[0].reserved = 2;
    mockDb.stockBalance[0].blocked = 3;
    mockDb.stockBalance[0].available = 13;
    mockDb.traslados = [
      {
        id: 't1',
        traslado_id: 't1',
        sku_id: skuNik,
        source_location_id: locLurin,
        target_location_id: locMiraflores,
        quantity_shipped: 1,
        quantity_received: 0,
        estado: 'EN_TRANSITO',
      },
      {
        id: 't3',
        traslado_id: 't3',
        sku_id: 'OTRO-SKU',
        source_location_id: locMiraflores,
        target_location_id: locLurin,
        quantity_shipped: 1,
        quantity_received: 0,
        estado: 'EN_TRANSITO',
      },
      {
        id: 't2',
        traslado_id: 't2',
        sku_id: skuNik,
        source_location_id: locLurin,
        target_location_id: locMiraflores,
        quantity_shipped: 1,
        quantity_received: 1,
        estado: 'COMPLETADO_CON_DISCREPANCIA',
      },
    ];
    const internal = await service.obtenerMetricasInternas();
    expect(internal).toMatchObject({
      unidadesFisicas: 34,
      unidadesReservadas: 2,
      unidadesBloqueadas: 3,
      unidadesDisponibles: 29,
      trasladosPendientes: 2,
      trasladosConDiscrepancia: 1,
    });
    const publicDto = await service.obtenerDashboard({});
    expect(publicDto).not.toHaveProperty('unidadesBloqueadas');
    expect(publicDto).not.toHaveProperty('trasladosPendientes');

    expect(
      (await service.obtenerMetricasInternas({ sku: skuNik }))
        .trasladosPendientes,
    ).toBe(1);
    expect(
      (await service.obtenerMetricasInternas({ locationId: locMiraflores }))
        .trasladosPendientes,
    ).toBe(2);
    expect(
      (
        await service.obtenerMetricasInternas({
          sku: skuNik,
          locationId: locMiraflores,
        })
      ).trasladosConDiscrepancia,
    ).toBe(1);
    expect(
      await service.obtenerMetricasInternas({ sku: 'SKU-AUSENTE' }),
    ).toMatchObject({ trasladosPendientes: 0, trasladosConDiscrepancia: 0 });
  });

  it('el override por SKU prevalece sobre el global', async () => {
    mockDb.thresholdOverrides = [
      { id: 't-global', sku_id: null, location_id: null, umbral_efectivo: 3 },
      { id: 't-nik', sku_id: skuNik, location_id: null, umbral_efectivo: 100 },
    ];
    const res = await service.obtenerDashboard({});
    // NIK (22) queda como STOCK_BAJO por su override 100; ADI (10) y PUM (2) con global 3.
    expect(res.skusStockBajo).toBe(2); // NIK + PUM
    expect(res.skusDisponibles).toBe(1); // ADI
  });

  it('rechaza filtros de catálogo que no puede aplicar (400 VALIDACION)', async () => {
    await expect(
      service.obtenerDashboard({ productoId: 'prod-1' }),
    ).rejects.toMatchObject({ problem: { status: 400, code: 'VALIDACION' } });
  });

  describe('listarSaldosFisicos (INV-B03)', () => {
    it('devuelve saldos físicos con campos de ubicación real del JOIN y calcula estados', async () => {
      const res = await service.listarSaldosFisicos({});

      expect(res.meta.total).toBe(4); // 4 saldos en mockDb
      expect(res.items).toHaveLength(4);

      for (const item of res.items) {
        expect(item.sku).toBeDefined();
        expect(item.ubicacion.locationId).toBeDefined();
        expect(item.ubicacion.codigo).toMatch(/^ALM-|^TDA-/);
        expect(item.ubicacion.nombre).toBeDefined();
        expect(['DISPONIBLE', 'STOCK_BAJO', 'AGOTADO']).toContain(item.estado);
        expect(item.stockVersion).toBeGreaterThanOrEqual(1);
      }
    });

    it('respeta paginación y orden determinista sin duplicados entre páginas', async () => {
      const p1 = await service.listarSaldosFisicos({
        pagina: '1',
        tamanio: '2',
      });
      expect(p1.items).toHaveLength(2);
      expect(p1.meta.pagina).toBe(1);
      expect(p1.meta.tamanio).toBe(2);
      expect(p1.meta.totalPaginas).toBe(2);

      const p2 = await service.listarSaldosFisicos({
        pagina: '2',
        tamanio: '2',
      });
      expect(p2.items).toHaveLength(2);
      expect(p2.meta.pagina).toBe(2);

      const keys1 = p1.items.map((i) => `${i.sku}:${i.ubicacion.locationId}`);
      const keys2 = p2.items.map((i) => `${i.sku}:${i.ubicacion.locationId}`);
      // Ningún item de la página 1 debe repetirse en la página 2
      expect(keys1.some((k) => keys2.includes(k))).toBe(false);
    });

    it('filtra correctamente por SKU, ubicación y estado', async () => {
      const porSku = await service.listarSaldosFisicos({ sku: skuNik });
      expect(porSku.items.every((i) => i.sku === skuNik)).toBe(true);

      const porLoc = await service.listarSaldosFisicos({
        locationId: locLurin,
      });
      expect(
        porLoc.items.every((i) => i.ubicacion.locationId === locLurin),
      ).toBe(true);
    });

    it('rechaza parámetros inválidos con 400 VALIDACION', async () => {
      await expect(
        service.listarSaldosFisicos({ locationId: 'no-es-uuid' }),
      ).rejects.toMatchObject({ problem: { status: 400, code: 'VALIDACION' } });

      await expect(
        service.listarSaldosFisicos({ estado: 'ESTADO_INVALIDO' }),
      ).rejects.toMatchObject({ problem: { status: 400, code: 'VALIDACION' } });
    });
  });
});
