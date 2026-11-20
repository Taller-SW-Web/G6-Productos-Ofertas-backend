import { describe, it, expect, beforeEach } from 'vitest';
import { DashboardService } from './dashboard.service.js';
import { DatabaseService } from '../database/database.service.js';
import { InMemoryDatabaseMock } from '../../test/in-memory-database.mock.js';

describe('DashboardService — Alertas operativas internas (Extensión H01 / INV-B06)', () => {
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

  it('emite alertas solo para saldos en AGOTADO o STOCK_BAJO calculados con umbral efectivo', async () => {
    // Estado inicial mock:
    // NIK en Lurín: on_hand 20, reserved 0, blocked 0 -> available 20 (defaultThreshold 10 -> DISPONIBLE)
    // NIK en Miraflores: on_hand 2, reserved 0, blocked 0 -> available 2 (defaultThreshold 10 -> STOCK_BAJO)
    // ADI en Lurín: on_hand 10 -> available 10 (STOCK_BAJO porque available <= 10)
    // PUM en Miraflores: on_hand 2 -> available 2 (STOCK_BAJO)

    // Agotamos ADI en Lurín
    const adiBalance = mockDb.stockBalance.find(
      (b) => b.sku_id === skuAdi && b.location_id === locLurin,
    )!;
    adiBalance.on_hand = 0;
    adiBalance.available = 0;

    const res = await service.obtenerAlertasInternas();

    expect(res.items.length).toBeGreaterThanOrEqual(1);
    // Cada item debe tener estado AGOTADO o STOCK_BAJO, nunca DISPONIBLE
    for (const item of res.items) {
      expect(['AGOTADO', 'STOCK_BAJO']).toContain(item.estado);
      expect(item.alertaId).toBe(
        `${item.sku}:${item.ubicacion.locationId}:${item.estado}`,
      );
      expect(item.targetRoute).toBe(
        `/inventario/saldos?sku=${encodeURIComponent(item.sku)}&locationId=${item.ubicacion.locationId}`,
      );
      expect(item.observadoEn).toBeDefined();
      expect(item.ubicacion.codigo).toBeDefined();
      expect(item.ubicacion.nombre).toBeDefined();
    }

    const agotadoItem = res.items.find(
      (i) => i.sku === skuAdi && i.ubicacion.locationId === locLurin,
    );
    expect(agotadoItem).toBeDefined();
    expect(agotadoItem?.estado).toBe('AGOTADO');
    expect(agotadoItem?.available).toBe(0);
  });

  it('no emite alerta para ubicación inactiva (locations.active = false)', async () => {
    // Desactivamos Miraflores
    const miraflores = mockDb.locations.find((l) => l.id === locMiraflores)!;
    miraflores.active = false;

    const res = await service.obtenerAlertasInternas({
      locationId: locMiraflores,
    });
    expect(res.items).toHaveLength(0);
    expect(res.meta.total).toBe(0);
  });

  it('no genera alertas artificiales para SKUs sin saldo registrado', async () => {
    const res = await service.obtenerAlertasInternas({
      sku: 'SKU-INEXISTENTE',
    });
    expect(res.items).toHaveLength(0);
    expect(res.meta.total).toBe(0);
  });

  it('respeta override de umbral por SKU sobre el umbral global', async () => {
    // Ponemos override muy bajo para NIK (umbral = 1)
    // NIK en Miraflores tiene available = 2. Con umbral 1, 2 > 1 -> queda DISPONIBLE, no debe alertar
    mockDb.thresholdOverrides = [
      { id: 't-nik', sku_id: skuNik, location_id: null, umbral_efectivo: 1 },
    ];

    const res = await service.obtenerAlertasInternas({ sku: skuNik });
    // Ni Lurín (20) ni Miraflores (2) deben generar alerta ya que ambos superan umbral 1
    expect(res.items).toHaveLength(0);
  });

  it('filtra por estado AGOTADO o STOCK_BAJO', async () => {
    // Agotamos ADI
    const adiBalance = mockDb.stockBalance.find(
      (b) => b.sku_id === skuAdi && b.location_id === locLurin,
    )!;
    adiBalance.on_hand = 0;
    adiBalance.available = 0;

    const soloAgotados = await service.obtenerAlertasInternas({
      estado: 'AGOTADO',
    });
    expect(soloAgotados.items.every((i) => i.estado === 'AGOTADO')).toBe(true);

    const soloStockBajo = await service.obtenerAlertasInternas({
      estado: 'STOCK_BAJO',
    });
    expect(soloStockBajo.items.every((i) => i.estado === 'STOCK_BAJO')).toBe(
      true,
    );
  });

  it('rechaza estado inválido (DISPONIBLE o texto ajeno) con 400 VALIDACION', async () => {
    await expect(
      service.obtenerAlertasInternas({ estado: 'DISPONIBLE' }),
    ).rejects.toMatchObject({
      problem: { status: 400, code: 'VALIDACION' },
    });

    await expect(
      service.obtenerAlertasInternas({ estado: 'OTRO_ESTADO' }),
    ).rejects.toMatchObject({
      problem: { status: 400, code: 'VALIDACION' },
    });
  });

  it('rechaza filtros no permitidos con 400 VALIDACION', async () => {
    await expect(
      service.obtenerAlertasInternas({ filtroInventado: 'valor' } as any),
    ).rejects.toMatchObject({
      problem: { status: 400, code: 'VALIDACION' },
    });
  });

  it('respeta paginación server-side y límites seguros', async () => {
    const res = await service.obtenerAlertasInternas({
      pagina: '1',
      tamanio: '1',
    });
    expect(res.meta.pagina).toBe(1);
    expect(res.meta.tamanio).toBe(1);
    expect(res.items.length).toBeLessThanOrEqual(1);

    await expect(
      service.obtenerAlertasInternas({ pagina: '0' }),
    ).rejects.toMatchObject({
      problem: { status: 400, code: 'VALIDACION' },
    });

    await expect(
      service.obtenerAlertasInternas({ tamanio: '200' }), // excede max 100
    ).rejects.toMatchObject({
      problem: { status: 400, code: 'VALIDACION' },
    });
  });
});
