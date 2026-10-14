import { describe, it, expect, beforeEach } from 'vitest';
import { DisponibilidadService } from './disponibilidad.service.js';
import { DatabaseService } from '../database/database.service.js';
import { InMemoryDatabaseMock } from '../../test/in-memory-database.mock.js';

describe('DisponibilidadService — Consultas de Stock y D-INV-01', () => {
  let disponibilidadService: DisponibilidadService;
  let mockDb: InMemoryDatabaseMock;
  let dbService: DatabaseService;

  const locLurin = '9129b578-631e-1735-8427-b683fb524380';
  const locMiraflores = 'aea2f0d8-e8c6-b09c-8e7a-b4a3630bc485';

  beforeEach(() => {
    mockDb = new InMemoryDatabaseMock();
    dbService = new DatabaseService();
    dbService.setCustomService(mockDb);
    disponibilidadService = new DisponibilidadService(dbService);
  });

  describe('Consulta autoritativa detallada (GET /api/v1/inventario/disponibilidad)', () => {
    it('debe calcular available y clasificar estados de stock correctamente', async () => {
      // NIK-REV7-NEG-41 tiene 18 en Lurín y 4 en Miraflores
      // Configuramos un saldo con 0 para probar AGOTADO
      mockDb.stockBalance.push({
        sku_id: 'SKU-ZERO',
        location_id: locLurin,
        on_hand: 5,
        reserved: 5,
        blocked: 0,
        available: 0,
        stock_version: 1,
      });

      // Configuramos un saldo con stock bajo (3 unidades con umbral 5)
      mockDb.stockBalance.push({
        sku_id: 'SKU-LOW',
        location_id: locLurin,
        on_hand: 3,
        reserved: 0,
        blocked: 0,
        available: 3,
        stock_version: 1,
      });

      const res = await disponibilidadService.consultarDisponibilidad([
        'NIK-REV7-NEG-41',
        'SKU-ZERO',
        'SKU-LOW',
      ]);

      expect(res.items).toBeDefined();
      expect(res.items.length).toBeGreaterThanOrEqual(3);

      const itemZero = res.items.find((i) => i.sku === 'SKU-ZERO')!;
      expect(itemZero.available).toBe(0);
      expect(itemZero.status).toBe('AGOTADO');

      const itemLow = res.items.find((i) => i.sku === 'SKU-LOW')!;
      expect(itemLow.available).toBe(3);
      expect(itemLow.status).toBe('STOCK_BAJO');

      const itemLurin = res.items.find(
        (i) => i.sku === 'NIK-REV7-NEG-41' && i.location_id === locLurin,
      )!;
      expect(itemLurin.available).toBe(18);
      expect(itemLurin.status).toBe('DISPONIBLE');
    });

    it('debe filtrar por location_id cuando se especifica', async () => {
      const res = await disponibilidadService.consultarDisponibilidad(
        ['NIK-REV7-NEG-41'],
        locMiraflores,
      );

      expect(res.items).toHaveLength(1);
      expect(res.items[0].location_id).toBe(locMiraflores);
      expect(res.items[0].on_hand).toBe(4);
    });
  });

  describe('Verificación comercial de cantidades D-INV-01 (POST /comercial/verificar)', () => {
    it('debe responder INDETERMINADO si no existe ruta unívoca de cumplimiento', async () => {
      // Sin rutas comerciales configuradas
      const res = await disponibilidadService.verificarCantidadComercial({
        channel_id: 'MARKETPLACE',
        fulfillment: {
          mode: 'ENVIO_DOMICILIO',
          fulfillment_ref: 'REF-SIN-RUTA',
        },
        lines: [{ sku: 'NIK-REV7-NEG-41', quantity: 2 }],
      });

      expect(res.binding).toBe(false);
      expect(res.items).toHaveLength(1);
      expect(res.items[0].result).toBe('INDETERMINADO');
      expect(res.items[0].reason_code).toBe('RUTA_CUMPLIMIENTO_NO_RESUELTA');
    });

    it('debe responder SUFICIENTE o INSUFICIENTE cuando la ruta está unívocamente resuelta', async () => {
      // Configuramos una ruta activa hacia el almacén de Lurín
      mockDb.commercialRoutes.push({
        id: 'route-1',
        channel_id: 'MARKETPLACE',
        mode: 'ENVIO_DOMICILIO',
        fulfillment_ref: 'LIMA_METROPOLITANA',
        location_id: locLurin,
        active: true,
      });

      // Lurín tiene 18 de NIK-REV7-NEG-41 y 2 de PUM-LIMIT-01
      const res = await disponibilidadService.verificarCantidadComercial({
        channel_id: 'MARKETPLACE',
        fulfillment: {
          mode: 'ENVIO_DOMICILIO',
          fulfillment_ref: 'LIMA_METROPOLITANA',
        },
        lines: [
          { sku: 'NIK-REV7-NEG-41', quantity: 5 }, // Suficiente (18 >= 5)
          { sku: 'PUM-LIMIT-01', quantity: 10 }, // Insuficiente (2 < 10)
        ],
      });

      expect(res.items).toHaveLength(2);

      const item1 = res.items.find((i) => i.sku === 'NIK-REV7-NEG-41')!;
      expect(item1.result).toBe('SUFICIENTE');
      expect(item1.reason_code).toBeNull();

      const item2 = res.items.find((i) => i.sku === 'PUM-LIMIT-01')!;
      expect(item2.result).toBe('INSUFICIENTE');
      expect(item2.reason_code).toBe('STOCK_INSUFICIENTE');
    });
  });
});
