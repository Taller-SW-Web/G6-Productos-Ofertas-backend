export const REQUIRED_SCOPE_KEY = 'required_scope';
export const ALLOWED_CLIENTS_KEY = 'allowed_clients';

export const EXPECTED_AUDIENCE = 'api-productos';
export const EXPECTED_ALGORITHM = 'RS256';
export const EXPECTED_TOKEN_TYPE = 'servicio';

export function getConfiguredIssuer(): string | null {
  const issuer = process.env.G7_JWT_ISSUER?.trim();
  return issuer ? issuer : null;
}

export const INVENTORY_SCOPES = {
  RESERVAR: 'inventario:reservar',
  CONSUMIR: 'inventario:consumir',
  LIBERAR: 'inventario:liberar',
  OPERACIONES_LEER: 'inventario:operaciones:leer',
  DISPONIBILIDAD_LEER: 'inventario:disponibilidad:leer',
} as const;

export const KNOWN_CLIENTS = {
  VENTAS: 'modulo-ventas',
  POSTVENTA: 'modulo-postventa',
  MARKETPLACE: 'modulo-marketplace',
  CHATBOT: 'modulo-chatbot',
  RETAIL: 'modulo-retail',
} as const;
