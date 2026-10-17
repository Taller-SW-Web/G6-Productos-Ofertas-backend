export type Canal = 'MARKETPLACE' | 'CHATBOT' | 'RETAIL' | 'VENTAS';

export type CanalComercial = 'MARKETPLACE' | 'CHATBOT' | 'RETAIL';

export type EstadoStock = 'AGOTADO' | 'STOCK_BAJO' | 'DISPONIBLE';

export type EstadoComercial =
  'DISPONIBLE' | 'STOCK_BAJO' | 'AGOTADO' | 'INDETERMINADO';

export type OperacionInventarioTipo =
  | 'RESERVAR'
  | 'CONFIRMAR_CONSUMO'
  | 'LIBERAR'
  | 'REINTEGRAR'
  | 'CONCILIAR_OFFLINE';

export type OperacionInventarioEstado =
  'ACCEPTED' | 'PROCESSING' | 'COMPLETED' | 'REJECTED' | 'REQUIRES_REVIEW';

export type MotivoLiberacion =
  'PAGO_NO_COMPLETADO' | 'ANULACION' | 'EXPIRACION_FORZADA' | 'OTRO';

export class LineaInventario {
  sku!: string;
  quantity!: number;
  location_id?: string | null;
}

export class CrearReservaRequest {
  order_id!: string;
  operation_id!: string;
  channel_id!: Canal;
  lines!: LineaInventario[];
}

export class OperacionReservaRequest {
  order_id!: string;
  operation_id!: string;
}

export class LiberarReservaRequest {
  order_id!: string;
  operation_id!: string;
  reason!: MotivoLiberacion;
}

export interface OperacionInventarioAceptada {
  operation_id: string;
  order_id: string;
  operation_type: OperacionInventarioTipo;
  status: 'ACCEPTED';
  correlation_id: string | null;
}

export interface ConsultaOperacionInventario {
  operation_id: string;
  order_id: string;
  operation_type: OperacionInventarioTipo;
  status: OperacionInventarioEstado;
  reservation_id?: string | null;
  expires_at?: string | null;
  result_code?: string | null;
  accepted_at: string;
  completed_at?: string | null;
}

export interface DisponibilidadStock {
  sku: string;
  location_id?: string | null;
  on_hand: number;
  reserved: number;
  blocked: number;
  available: number;
  status: EstadoStock;
  threshold?: number | null;
}

export interface ConsultaDisponibilidadResponse {
  items: DisponibilidadStock[];
}

export interface DisponibilidadComercial {
  sku: string;
  status: EstadoComercial;
}

export interface ConsultaDisponibilidadComercialResponse {
  items: DisponibilidadComercial[];
}

export class VerificarCantidadComercialLinea {
  sku!: string;
  quantity!: number;
}

export class VerificarCantidadComercialFulfillment {
  mode!: 'ENVIO_DOMICILIO' | 'RETIRO_TIENDA' | 'VENTA_TIENDA';
  fulfillment_ref?: string;
}

export class VerificarCantidadComercialRequest {
  channel_id!: Canal;
  fulfillment?: VerificarCantidadComercialFulfillment;
  lines!: VerificarCantidadComercialLinea[];
}

export interface VerificarCantidadComercialItem {
  sku: string;
  requested_quantity: number;
  result: 'SUFICIENTE' | 'INSUFICIENTE' | 'INDETERMINADO';
  reason_code?: string | null;
}

export interface VerificarCantidadComercialResponse {
  evaluated_at: string;
  binding: false;
  items: VerificarCantidadComercialItem[];
}

export type MotivoReintegroInventario =
  'DEVOLUCION_ACEPTADA' | 'ANULACION_POST_CONSUMO' | 'RETORNO_LOGISTICO';

export interface LineaInventarioUbicada {
  sku: string;
  quantity: number;
  location_id: string;
}

export class ReintegroInventarioRequest {
  operation_id!: string;
  order_id!: string;
  source_ref!: string;
  reason!: MotivoReintegroInventario;
  lines!: LineaInventarioUbicada[];
}

export interface ReintegroLineaResultado {
  sku: string;
  location_id: string;
  quantity: number;
  on_hand: number;
  reserved: number;
  blocked: number;
  available: number;
  stock_version: number;
}

export interface ReintegroInventarioResponse {
  operation_id: string;
  order_id: string;
  source_ref: string;
  status: 'COMPLETED';
  lines: ReintegroLineaResultado[];
  completed_at: string;
}
