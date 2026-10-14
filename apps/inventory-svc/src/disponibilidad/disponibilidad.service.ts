import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';
import { loadInventoryConfig } from '../config/inventory.config.js';
import {
  ConsultaDisponibilidadResponse,
  DisponibilidadStock,
  EstadoStock,
  VerificarCantidadComercialRequest,
  VerificarCantidadComercialResponse,
  VerificarCantidadComercialItem,
} from '../types/inventory.dto.js';
import { ProblemDetailsException } from '../errors/inventory.errors.js';

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class DisponibilidadService {
  constructor(private readonly databaseService: DatabaseService) {}

  /**
   * Consulta la disponibilidad autoritativa detallada por SKU y ubicación (GET /api/v1/inventario/disponibilidad)
   */
  async consultarDisponibilidad(
    skus: string[],
    locationId?: string,
    correlationId?: string,
  ): Promise<ConsultaDisponibilidadResponse> {
    if (!Array.isArray(skus) || skus.length === 0) {
      throw ProblemDetailsException.validation(
        'El parámetro skus es obligatorio y debe contener al menos un elemento',
        correlationId,
      );
    }
    if (skus.length > 100) {
      throw ProblemDetailsException.validation(
        'El parámetro skus no puede exceder 100 elementos',
        correlationId,
      );
    }
    if (locationId && !UUID_REGEX.test(locationId)) {
      throw ProblemDetailsException.validation(
        'location_id debe ser un UUID válido',
        correlationId,
      );
    }

    const config = loadInventoryConfig();
    const defaultThreshold = config.defaultLowStockThreshold;

    // Obtener overrides de umbral
    const thresholdRes = await this.databaseService.query(
      `SELECT sku_id, umbral_efectivo FROM inventory.stock_threshold_override`,
    );

    let globalThreshold = defaultThreshold;
    const skuThresholdMap = new Map<string, number>();

    for (const row of thresholdRes.rows) {
      if (row.sku_id === null) {
        globalThreshold = Number(row.umbral_efectivo);
      } else {
        skuThresholdMap.set(row.sku_id, Number(row.umbral_efectivo));
      }
    }

    // Consultar saldos
    let sql = `
      SELECT sku_id, location_id, on_hand, reserved, blocked, available, stock_version
      FROM inventory.stock_balance
      WHERE sku_id = ANY($1)
    `;
    const params: any[] = [skus];

    if (locationId) {
      sql += ` AND location_id = $2`;
      params.push(locationId);
    }

    sql += ` ORDER BY sku_id ASC, location_id ASC`;

    const res = await this.databaseService.query(sql, params);

    const items: DisponibilidadStock[] = res.rows.map((row: any) => {
      const onHand = Number(row.on_hand);
      const reserved = Number(row.reserved);
      const blocked = Number(row.blocked);
      const available = Math.max(0, onHand - reserved - blocked);

      const threshold = skuThresholdMap.get(row.sku_id) ?? globalThreshold;

      let status: EstadoStock = 'DISPONIBLE';
      if (available === 0) {
        status = 'AGOTADO';
      } else if (available <= threshold) {
        status = 'STOCK_BAJO';
      }

      return {
        sku: row.sku_id,
        location_id: row.location_id,
        on_hand: onHand,
        reserved,
        blocked,
        available,
        status,
        threshold,
      };
    });

    return { items };
  }

  /**
   * Verificación comercial de cantidades conforme a la política D-INV-01 (POST /api/v1/inventario/disponibilidad/comercial/verificar)
   */
  async verificarCantidadComercial(
    dto: VerificarCantidadComercialRequest,
    correlationId?: string,
  ): Promise<VerificarCantidadComercialResponse> {
    if (
      !dto ||
      !dto.channel_id ||
      !Array.isArray(dto.lines) ||
      dto.lines.length === 0
    ) {
      throw ProblemDetailsException.validation(
        'Solicitud inválida para verificación comercial',
        correlationId,
      );
    }

    for (const line of dto.lines) {
      if (!line.sku || typeof line.sku !== 'string') {
        throw ProblemDetailsException.validation(
          'Cada línea debe especificar sku',
          correlationId,
        );
      }
      if (
        typeof line.quantity !== 'number' ||
        !Number.isInteger(line.quantity) ||
        line.quantity <= 0
      ) {
        throw ProblemDetailsException.cantidadInvalida(
          'La cantidad debe ser un entero positivo',
          correlationId,
        );
      }
    }

    const evaluatedAt = new Date().toISOString();

    // D-INV-01: resolución de ruta de cumplimiento unívoca
    let targetLocationId: string | null = null;

    if (dto.fulfillment?.mode && dto.fulfillment?.fulfillment_ref) {
      const routeRes = await this.databaseService.query(
        `SELECT location_id FROM inventory.commercial_fulfillment_routes
         WHERE channel_id = $1 AND mode = $2 AND fulfillment_ref = $3 AND active = true`,
        [dto.channel_id, dto.fulfillment.mode, dto.fulfillment.fulfillment_ref],
      );
      if (routeRes.rows.length === 1) {
        targetLocationId = routeRes.rows[0].location_id;
      }
    } else {
      // Intento de fallback de canal
      const routeRes = await this.databaseService.query(
        `SELECT location_id FROM inventory.commercial_fulfillment_routes
         WHERE channel_id = $1 AND active = true`,
        [dto.channel_id],
      );
      if (routeRes.rows.length === 1) {
        targetLocationId = routeRes.rows[0].location_id;
      }
    }

    // Si falta la correspondencia o es ambigua: devolver INDETERMINADO sin mutar ni inventar almacén
    if (!targetLocationId) {
      const indeterminateItems: VerificarCantidadComercialItem[] =
        dto.lines.map((line) => ({
          sku: line.sku,
          requested_quantity: line.quantity,
          result: 'INDETERMINADO',
          reason_code: 'RUTA_CUMPLIMIENTO_NO_RESUELTA',
        }));

      return {
        evaluated_at: evaluatedAt,
        binding: false,
        items: indeterminateItems,
      };
    }

    // Ubicación resuelta: verificar capacidad en esa ubicación única
    const items: VerificarCantidadComercialItem[] = [];

    for (const line of dto.lines) {
      const balRes = await this.databaseService.query(
        `SELECT on_hand, reserved, blocked
         FROM inventory.stock_balance
         WHERE sku_id = $1 AND location_id = $2`,
        [line.sku, targetLocationId],
      );

      if (balRes.rows.length === 0) {
        items.push({
          sku: line.sku,
          requested_quantity: line.quantity,
          result: 'INSUFICIENTE',
          reason_code: 'STOCK_INSUFICIENTE',
        });
        continue;
      }

      const bal = balRes.rows[0];
      const available = Math.max(
        0,
        Number(bal.on_hand) - Number(bal.reserved) - Number(bal.blocked),
      );

      if (available >= line.quantity) {
        items.push({
          sku: line.sku,
          requested_quantity: line.quantity,
          result: 'SUFICIENTE',
          reason_code: null,
        });
      } else {
        items.push({
          sku: line.sku,
          requested_quantity: line.quantity,
          result: 'INSUFICIENTE',
          reason_code: 'STOCK_INSUFICIENTE',
        });
      }
    }

    return {
      evaluated_at: evaluatedAt,
      binding: false,
      items,
    };
  }
}
