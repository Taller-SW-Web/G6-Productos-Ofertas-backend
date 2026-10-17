import {
  IDatabaseClient,
  IDatabaseService,
  QueryResult,
} from '../src/database/database.interface.js';

export interface LocationRow {
  id: string;
  code: string;
  name: string;
  type: string;
  external_ref?: string | null;
  active: boolean;
}

export interface StockBalanceRow {
  sku_id: string;
  location_id: string;
  on_hand: number;
  reserved: number;
  blocked: number;
  available: number;
  stock_version: number;
}

export interface ReservationRow {
  id: string;
  reservation_id: string;
  status: 'ACTIVA' | 'CONSUMIDA' | 'LIBERADA' | 'EXPIRADA';
  expires_at: string;
  idempotency_key: string;
  intention: string;
  correlation_id?: string | null;
  order_id?: string | null;
  operation_id?: string | null;
  consumed_at?: string | null;
  released_at?: string | null;
  expired_at?: string | null;
  request_fingerprint?: string | null;
  accepted_payload?: any;
}

export interface ReservationLineRow {
  id: string;
  reservation_id: string;
  sku_id: string;
  location_id: string;
  quantity: number;
}

export interface OperationRow {
  id: string;
  operation_type: string;
  idempotency_key: string;
  intention: string;
  status: string;
  order_id?: string | null;
  reservation_id?: string | null;
  result_code?: string | null;
  operation_id?: string | null;
  request_fingerprint?: string | null;
  request_payload?: any;
  result_payload?: any;
  accepted_at?: string | null;
  applied_at?: string | null;
  correlation_id?: string | null;
  client_id?: string | null;
}

export interface KardexRow {
  id: string;
  sku_id: string;
  location_id: string;
  operation_type: string;
  operation_id?: string | null;
  reservation_id?: string | null;
  quantity: number;
  on_hand_before: number;
  on_hand_after: number;
  reserved_before: number;
  reserved_after: number;
  blocked_before: number;
  blocked_after: number;
  stock_version: number;
  correlation_id?: string | null;
}

export interface OutboxRow {
  id: string;
  event_id: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  correlation_id?: string | null;
  payload: any;
  status: 'PENDING' | 'PUBLISHED';
  published_at?: string | null;
  created_at: string;
}

export interface CommercialRouteRow {
  id: string;
  channel_id: string;
  mode: string;
  fulfillment_ref: string;
  location_id: string;
  active: boolean;
}

export interface ThresholdOverrideRow {
  id: string;
  sku_id?: string | null;
  location_id?: string | null;
  umbral_efectivo: number;
}

export class InMemoryDatabaseMock implements IDatabaseService {
  locations: LocationRow[] = [];
  stockBalance: StockBalanceRow[] = [];
  reservations: ReservationRow[] = [];
  reservationLines: ReservationLineRow[] = [];
  operations: OperationRow[] = [];
  kardex: KardexRow[] = [];
  outbox: OutboxRow[] = [];
  commercialRoutes: CommercialRouteRow[] = [];
  thresholdOverrides: ThresholdOverrideRow[] = [];

  private rowLocks = new Map<string, Promise<void>>();
  private lockResolvers = new Map<string, () => void>();
  private outboxHeldLocks = new Set<string>();

  constructor() {
    this.seedDefaults();
  }

  seedDefaults(): void {
    this.locations = [
      {
        id: '9129b578-631e-1735-8427-b683fb524380',
        code: 'ALM-LURIN',
        name: 'Centro de distribución Lurín',
        type: 'ALMACEN_CENTRAL',
        active: true,
      },
      {
        id: 'aea2f0d8-e8c6-b09c-8e7a-b4a3630bc485',
        code: 'TDA-MIRAFLORES',
        name: 'Tienda Miraflores',
        type: 'TIENDA',
        external_ref: 'TIENDA-MIRAFLORES',
        active: true,
      },
    ];

    this.stockBalance = [
      {
        sku_id: 'NIK-REV7-NEG-41',
        location_id: '9129b578-631e-1735-8427-b683fb524380',
        on_hand: 18,
        reserved: 0,
        blocked: 0,
        available: 18,
        stock_version: 1,
      },
      {
        sku_id: 'NIK-REV7-NEG-41',
        location_id: 'aea2f0d8-e8c6-b09c-8e7a-b4a3630bc485',
        on_hand: 4,
        reserved: 0,
        blocked: 0,
        available: 4,
        stock_version: 1,
      },
      {
        sku_id: 'ADI-RF3-GRI-38',
        location_id: '9129b578-631e-1735-8427-b683fb524380',
        on_hand: 10,
        reserved: 0,
        blocked: 0,
        available: 10,
        stock_version: 1,
      },
      {
        sku_id: 'PUM-LIMIT-01',
        location_id: '9129b578-631e-1735-8427-b683fb524380',
        on_hand: 2,
        reserved: 0,
        blocked: 0,
        available: 2,
        stock_version: 1,
      },
    ];

    this.commercialRoutes = [];
    this.reservations = [];
    this.reservationLines = [];
    this.operations = [];
    this.kardex = [];
    this.outbox = [];
    this.thresholdOverrides = [];
  }

  private cloneState() {
    return {
      locations: JSON.parse(JSON.stringify(this.locations)),
      stockBalance: JSON.parse(JSON.stringify(this.stockBalance)),
      reservations: JSON.parse(JSON.stringify(this.reservations)),
      reservationLines: JSON.parse(JSON.stringify(this.reservationLines)),
      operations: JSON.parse(JSON.stringify(this.operations)),
      kardex: JSON.parse(JSON.stringify(this.kardex)),
      outbox: JSON.parse(JSON.stringify(this.outbox)),
      commercialRoutes: JSON.parse(JSON.stringify(this.commercialRoutes)),
      thresholdOverrides: JSON.parse(JSON.stringify(this.thresholdOverrides)),
    };
  }

  private restoreState(snapshot: any) {
    this.locations = snapshot.locations;
    this.stockBalance = snapshot.stockBalance;
    this.reservations = snapshot.reservations;
    this.reservationLines = snapshot.reservationLines;
    this.operations = snapshot.operations;
    this.kardex = snapshot.kardex;
    this.outbox = snapshot.outbox;
    this.commercialRoutes = snapshot.commercialRoutes;
    this.thresholdOverrides = snapshot.thresholdOverrides;
  }

  private async acquireRowLock(key: string): Promise<void> {
    while (this.rowLocks.has(key)) {
      await this.rowLocks.get(key);
    }
    let resolver: () => void;
    const promise = new Promise<void>((res) => {
      resolver = res;
    });
    this.rowLocks.set(key, promise);
    this.lockResolvers.set(key, resolver!);
  }

  private releaseRowLock(key: string): void {
    const resolver = this.lockResolvers.get(key);
    if (resolver) {
      this.lockResolvers.delete(key);
      this.rowLocks.delete(key);
      resolver();
    }
  }

  async transaction<T>(
    fn: (client: IDatabaseClient) => Promise<T>,
  ): Promise<T> {
    const snapshot = this.cloneState();
    const heldLocks: string[] = [];

    const transactionalClient: IDatabaseClient = {
      query: async <R = any>(
        sql: string,
        params?: any[],
      ): Promise<QueryResult<R>> => {
        // If SELECT ... FOR UPDATE on stock_balance
        if (sql.includes('stock_balance') && sql.includes('FOR UPDATE')) {
          if (params && params.length >= 2) {
            const sku = params[0];
            const loc = params[1];
            const lockKey = `${sku}:::${loc}`;
            if (!heldLocks.includes(lockKey)) {
              await this.acquireRowLock(lockKey);
              heldLocks.push(lockKey);
            }
          }
        }
        return this.executeQuery<R>(sql, params, heldLocks);
      },
    };

    try {
      const result = await fn(transactionalClient);
      return result;
    } catch (err) {
      this.restoreState(snapshot);
      throw err;
    } finally {
      // Release held locks in reverse order
      for (const key of heldLocks) {
        if (key.startsWith('outbox:::')) {
          this.outboxHeldLocks.delete(key.substring(9));
        } else {
          this.releaseRowLock(key);
        }
      }
    }
  }

  async query<T = any>(sql: string, params?: any[]): Promise<QueryResult<T>> {
    return this.executeQuery<T>(sql, params);
  }

  async isHealthy(): Promise<{
    healthy: boolean;
    latencyMs?: number;
    error?: string;
  }> {
    return { healthy: true, latencyMs: 1 };
  }

  private executeQuery<T = any>(
    sql: string,
    params?: any[],
    heldLocks?: string[],
  ): QueryResult<T> {
    const s = sql.trim().toUpperCase();

    if (s.startsWith('SELECT 1')) {
      return { rows: [{ '?column?': 1 }] as any, rowCount: 1 };
    }

    // SELECT from locations
    if (s.includes('FROM INVENTORY.LOCATIONS')) {
      if (s.includes('WHERE ACTIVE = TRUE')) {
        return {
          rows: this.locations.filter((l) => l.active) as any,
          rowCount: this.locations.length,
        };
      }
      return { rows: this.locations as any, rowCount: this.locations.length };
    }

    // SELECT from commercial_fulfillment_routes
    if (s.includes('FROM INVENTORY.COMMERCIAL_FULFILLMENT_ROUTES')) {
      const channel = params?.[0];
      const filtered = this.commercialRoutes.filter(
        (r) => r.active && r.channel_id === channel,
      );
      return { rows: filtered as any, rowCount: filtered.length };
    }

    // SELECT from stock_threshold_override
    if (s.includes('FROM INVENTORY.STOCK_THRESHOLD_OVERRIDE')) {
      return {
        rows: this.thresholdOverrides as any,
        rowCount: this.thresholdOverrides.length,
      };
    }

    // SELECT from inventory_operations
    if (s.includes('FROM INVENTORY.INVENTORY_OPERATIONS')) {
      if (s.includes('WHERE OPERATION_ID = $1 OR IDEMPOTENCY_KEY = $2')) {
        const opId = params?.[0];
        const key = params?.[1];
        const rows = this.operations.filter(
          (o) => o.operation_id === opId || o.idempotency_key === key,
        );
        return { rows: rows as any, rowCount: rows.length };
      }
      if (
        s.includes('WHERE OPERATION_ID = $1') ||
        s.includes('WHERE O.OPERATION_ID = $1')
      ) {
        const opId = params?.[0];
        const rows = this.operations
          .filter((o) => o.operation_id === opId)
          .map((o) => {
            const res = this.reservations.find(
              (r) => r.reservation_id === o.reservation_id,
            );
            return {
              ...o,
              expires_at: res?.expires_at ?? null,
            };
          });
        return { rows: rows as any, rowCount: rows.length };
      }
    }

    // SELECT from reservations
    if (s.includes('FROM INVENTORY.RESERVATIONS')) {
      if (s.includes('WHERE RESERVATION_ID = $1')) {
        const resId = params?.[0];
        const rows = this.reservations.filter(
          (r) => r.reservation_id === resId,
        );
        return { rows: rows as any, rowCount: rows.length };
      }
      if (s.includes('WHERE ID = $1')) {
        const pk = params?.[0];
        const rows = this.reservations.filter((r) => r.id === pk);
        return { rows: rows as any, rowCount: rows.length };
      }
      if (s.includes("WHERE STATUS = 'ACTIVA'")) {
        const now = Date.now();
        const limit = params?.[0] ?? 50;
        const rows = this.reservations
          .filter(
            (r) =>
              r.status === 'ACTIVA' && new Date(r.expires_at).getTime() < now,
          )
          .slice(0, limit);
        return { rows: rows as any, rowCount: rows.length };
      }
    }

    // SELECT from reservation_lines
    if (s.includes('FROM INVENTORY.RESERVATION_LINES')) {
      if (s.includes('WHERE RESERVATION_ID = $1')) {
        const resId = params?.[0];
        const rows = this.reservationLines.filter(
          (l) => l.reservation_id === resId,
        );
        return { rows: rows as any, rowCount: rows.length };
      }
    }

    // SELECT from stock_balance
    if (s.includes('FROM INVENTORY.STOCK_BALANCE')) {
      if (s.includes('WHERE SKU_ID = ANY($1)')) {
        const skus: string[] = params?.[0] || [];
        const loc = params?.[1];
        let rows = this.stockBalance.filter((b) => skus.includes(b.sku_id));
        if (loc) {
          rows = rows.filter((b) => b.location_id === loc);
        }
        return { rows: rows as any, rowCount: rows.length };
      }
      if (s.includes('WHERE SKU_ID = $1 AND LOCATION_ID = $2')) {
        const sku = params?.[0];
        const loc = params?.[1];
        const rows = this.stockBalance.filter(
          (b) => b.sku_id === sku && b.location_id === loc,
        );
        return { rows: rows as any, rowCount: rows.length };
      }
    }

    // SELECT from outbox
    if (s.includes('FROM INVENTORY.OUTBOX')) {
      if (s.includes("WHERE STATUS = 'PENDING'")) {
        const limit = params?.[0] ?? 50;
        const isSkipLocked = s.includes('SKIP LOCKED');
        const rows = this.outbox
          .filter(
            (o) =>
              o.status === 'PENDING' &&
              (!isSkipLocked || !this.outboxHeldLocks.has(o.id)),
          )
          .slice(0, limit);

        if (isSkipLocked && heldLocks) {
          for (const r of rows) {
            this.outboxHeldLocks.add(r.id);
            heldLocks.push(`outbox:::${r.id}`);
          }
        }
        return { rows: rows as any, rowCount: rows.length };
      }
    }

    // INSERT INTO reservations
    if (s.startsWith('INSERT INTO INVENTORY.RESERVATIONS')) {
      const id = 'res-pk-' + Math.random().toString(36).substring(2);
      let row: ReservationRow;
      if (params && params.length === 10) {
        row = {
          id,
          reservation_id: params[0],
          status: params[1],
          expires_at: params[2],
          idempotency_key: params[3],
          intention: params[4],
          correlation_id: params[5],
          order_id: params[6],
          operation_id: params[7],
          request_fingerprint: params[8],
          accepted_payload: params[9]
            ? typeof params[9] === 'string'
              ? JSON.parse(params[9])
              : params[9]
            : undefined,
        };
      } else {
        row = {
          id,
          reservation_id: params?.[0],
          status: 'ACTIVA',
          expires_at: params?.[1],
          idempotency_key: params?.[2],
          intention: 'reservar',
          correlation_id: params?.[3],
          order_id: params?.[4],
          operation_id: params?.[5],
          request_fingerprint: params?.[6],
          accepted_payload: params?.[7]
            ? typeof params?.[7] === 'string'
              ? JSON.parse(params[7])
              : params[7]
            : undefined,
        };
      }
      this.reservations.push(row);
      return { rows: [{ id }] as any, rowCount: 1 };
    }

    // INSERT INTO reservation_lines
    if (s.startsWith('INSERT INTO INVENTORY.RESERVATION_LINES')) {
      const row: ReservationLineRow = {
        id: 'line-' + Math.random().toString(36).substring(2),
        reservation_id: params?.[0],
        sku_id: params?.[1],
        location_id: params?.[2],
        quantity: params?.[3],
      };
      this.reservationLines.push(row);
      return { rows: [row] as any, rowCount: 1 };
    }

    // UPDATE stock_balance
    if (s.startsWith('UPDATE INVENTORY.STOCK_BALANCE')) {
      if (s.includes('SET RESERVED = $1, STOCK_VERSION = $2')) {
        const newReserved = Number(params?.[0]);
        const newVersion = Number(params?.[1]);
        const sku = params?.[2];
        const loc = params?.[3];
        const target = this.stockBalance.find(
          (b) => b.sku_id === sku && b.location_id === loc,
        );
        if (target) {
          target.reserved = newReserved;
          target.stock_version = newVersion;
          target.available = Math.max(
            0,
            target.on_hand - target.reserved - target.blocked,
          );
        }
        return { rows: [], rowCount: 1 };
      }
      if (s.includes('SET ON_HAND = $1, RESERVED = $2, STOCK_VERSION = $3')) {
        const newOnHand = Number(params?.[0]);
        const newReserved = Number(params?.[1]);
        const newVersion = Number(params?.[2]);
        const sku = params?.[3];
        const loc = params?.[4];
        const target = this.stockBalance.find(
          (b) => b.sku_id === sku && b.location_id === loc,
        );
        if (target) {
          target.on_hand = newOnHand;
          target.reserved = newReserved;
          target.stock_version = newVersion;
          target.available = Math.max(
            0,
            target.on_hand - target.reserved - target.blocked,
          );
        }
        return { rows: [], rowCount: 1 };
      }
      if (s.includes('SET STOCK_VERSION = $3, ON_HAND = $4')) {
        const sku = params?.[0];
        const loc = params?.[1];
        const newVersion = Number(params?.[2]);
        const newOnHand = Number(params?.[3]);
        const target = this.stockBalance.find(
          (b) => b.sku_id === sku && b.location_id === loc,
        );
        if (target) {
          target.on_hand = newOnHand;
          target.stock_version = newVersion;
          target.available = Math.max(
            0,
            target.on_hand - target.reserved - target.blocked,
          );
        }
        return { rows: [], rowCount: 1 };
      }
    }

    // UPDATE reservations
    if (s.startsWith('UPDATE INVENTORY.RESERVATIONS')) {
      if (
        s.includes("SET STATUS = 'CONSUMIDA'") ||
        (s.includes('SET STATUS = $1') && params?.[0] === 'CONSUMIDA')
      ) {
        const pk = params?.[params.length - 1];
        const target = this.reservations.find((r) => r.id === pk);
        if (target) {
          target.status = 'CONSUMIDA';
          target.consumed_at = new Date().toISOString();
        }
        return { rows: [], rowCount: 1 };
      }
      if (
        s.includes("SET STATUS = 'LIBERADA'") ||
        (s.includes('SET STATUS = $1') && params?.[0] === 'LIBERADA')
      ) {
        const pk = params?.[params.length - 1];
        const target = this.reservations.find((r) => r.id === pk);
        if (target) {
          target.status = 'LIBERADA';
          target.released_at = new Date().toISOString();
        }
        return { rows: [], rowCount: 1 };
      }
      if (
        s.includes("SET STATUS = 'EXPIRADA'") ||
        (s.includes('SET STATUS = $1') && params?.[0] === 'EXPIRADA')
      ) {
        const pk = params?.[params.length - 1];
        const target = this.reservations.find((r) => r.id === pk);
        if (target) {
          target.status = 'EXPIRADA';
          target.expired_at = new Date().toISOString();
        }
        return { rows: [], rowCount: 1 };
      }
    }

    // INSERT INTO kardex
    if (s.startsWith('INSERT INTO INVENTORY.KARDEX')) {
      const row: KardexRow = {
        id: 'kardex-' + Math.random().toString(36).substring(2),
        sku_id: params?.[0],
        location_id: params?.[1],
        operation_type: params?.[2],
        operation_id: params?.[3],
        reservation_id: params?.[4],
        quantity: params?.[5],
        on_hand_before: params?.[6],
        on_hand_after: params?.[7],
        reserved_before: params?.[8],
        reserved_after: params?.[9],
        blocked_before: params?.[10],
        blocked_after: params?.[11],
        stock_version: params?.[12],
        correlation_id: params?.[13],
      };
      this.kardex.push(row);
      return { rows: [row] as any, rowCount: 1 };
    }

    // INSERT INTO inventory_operations
    if (s.startsWith('INSERT INTO INVENTORY.INVENTORY_OPERATIONS')) {
      let row: OperationRow;
      if (params && (params.length === 12 || params.length === 13)) {
        row = {
          id: 'op-' + Math.random().toString(36).substring(2),
          operation_type: params[0],
          idempotency_key: params[1],
          intention: params[2],
          status: params[3],
          result_code: params[4] ?? undefined,
          order_id: params[5],
          reservation_id: params[6] ?? undefined,
          operation_id: params[7],
          request_fingerprint: params[8],
          request_payload: params[9]
            ? typeof params[9] === 'string'
              ? JSON.parse(params[9])
              : params[9]
            : undefined,
          result_payload: params[10]
            ? typeof params[10] === 'string'
              ? JSON.parse(params[10])
              : params[10]
            : undefined,
          correlation_id: params[11],
          client_id: params[12] ?? null,
          accepted_at: new Date().toISOString(),
          applied_at: new Date().toISOString(),
        };
      } else if (s.includes("'RECHAZADO'")) {
        row = {
          id: 'op-' + Math.random().toString(36).substring(2),
          operation_type: 'RESERVA',
          idempotency_key: params?.[0],
          intention: 'reservar',
          status: 'RECHAZADO',
          result_code: params?.[1],
          order_id: params?.[2],
          operation_id: params?.[3],
          request_fingerprint: params?.[4],
          request_payload: params?.[5] ? JSON.parse(params[5]) : undefined,
          result_payload: params?.[6] ? JSON.parse(params[6]) : undefined,
          correlation_id: params?.[7],
          accepted_at: new Date().toISOString(),
          applied_at: new Date().toISOString(),
        };
      } else {
        row = {
          id: 'op-' + Math.random().toString(36).substring(2),
          operation_type: s.includes("'CONSUMO'")
            ? 'CONSUMO'
            : s.includes("'LIBERACION'")
              ? 'LIBERACION'
              : 'RESERVA',
          idempotency_key: params?.[0],
          intention: s.includes("'CONSUMO'")
            ? 'confirmar_consumo'
            : s.includes("'LIBERACION'")
              ? 'liberar_reserva'
              : 'reservar',
          status: 'APLICADO',
          order_id: params?.[1],
          reservation_id: params?.[2],
          operation_id: params?.[3],
          request_fingerprint: params?.[4],
          request_payload: params?.[5] ? JSON.parse(params[5]) : undefined,
          result_payload: params?.[6] ? JSON.parse(params[6]) : undefined,
          correlation_id: params?.[7],
          accepted_at: new Date().toISOString(),
          applied_at: new Date().toISOString(),
        };
      }
      this.operations.push(row);
      return { rows: [row] as any, rowCount: 1 };
    }

    // INSERT INTO outbox
    if (s.startsWith('INSERT INTO INVENTORY.OUTBOX')) {
      const row: OutboxRow = {
        id: 'outbox-' + Math.random().toString(36).substring(2),
        event_id: params?.[0],
        event_type: params?.[1],
        aggregate_type: params?.[2],
        aggregate_id: params?.[3],
        correlation_id: params?.[4],
        payload: params?.[5] ? JSON.parse(params[5]) : undefined,
        status: 'PENDING',
        created_at: new Date().toISOString(),
      };
      this.outbox.push(row);
      return { rows: [row] as any, rowCount: 1 };
    }

    // UPDATE outbox SET status = 'PUBLISHED'
    if (
      s.startsWith('UPDATE INVENTORY.OUTBOX') &&
      s.includes("STATUS = 'PUBLISHED'")
    ) {
      const id = params?.[0];
      const target = this.outbox.find((o) => o.id === id);
      if (target) {
        target.status = 'PUBLISHED';
        target.published_at = new Date().toISOString();
      }
      return { rows: [], rowCount: 1 };
    }

    return { rows: [], rowCount: 0 };
  }
}
