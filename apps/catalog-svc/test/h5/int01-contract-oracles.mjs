export const DOCS_SHA = '40524e96c6973f84d74160076781702fe2a3da19';
export const CONTRACT_VERSION = '0.7.0-rc.3';

export const CONTRACT_OPERATIONS = Object.freeze([
  { id: 'catalog-admin-list', method: 'GET', path: '/productos/administracion', success: 200, owner: 'catalog-svc' },
  { id: 'catalog-product-create', method: 'POST', path: '/productos', success: 201, owner: 'catalog-svc' },
  { id: 'catalog-product-edit', method: 'PATCH', path: '/productos/{productoId}', success: 200, owner: 'catalog-svc' },
  { id: 'catalog-product-activate', method: 'POST', path: '/productos/{productoId}/activar', success: 200, owner: 'catalog-svc' },
  { id: 'catalog-preparation-read', method: 'GET', path: '/productos/{productoId}/preparacion', success: 200, owner: 'catalog-svc' },
  { id: 'catalog-preparation-retry', method: 'POST', path: '/productos/{productoId}/preparacion/reintentar', success: 202, owner: 'catalog-svc' },
  { id: 'pricing-effective-read', method: 'GET', path: '/precios?skus={sku}&canal={channel}', success: 200, owner: 'pricing-svc' },
  { id: 'inventory-availability-read', method: 'GET', path: '/inventario/disponibilidad?skus={sku}&location_id={location}', success: 200, owner: 'inventory-svc' },
]);

const TERMINAL = new Set(['COMPLETED', 'REJECTED']);
const NON_TERMINAL = new Set(['PENDING', 'INDETERMINATE']);

export function classifyPreparationResponse(httpStatus, body) {
  if (httpStatus === 202) {
    if (body?.status !== 'ACCEPTED' || !body?.operation_id || !body?.correlation_id)
      throw new Error('INT01_ACCEPTED_RESPONSE_INVALID');
    return { state: 'PENDING', terminal: false };
  }
  const state = body?.status;
  if (TERMINAL.has(state)) return { state, terminal: true };
  if (NON_TERMINAL.has(state)) return { state, terminal: false };
  throw new Error('INT01_PREPARATION_STATE_INVALID');
}

export function verifyRealProviderTrace(trace, requiredProviders, expectedSourceSha) {
  if (!Array.isArray(trace) || !Array.isArray(requiredProviders) || requiredProviders.length === 0)
    throw new Error('INT01_PROVIDER_TRACE_INVALID');
  if (!/^[0-9a-f]{40}$/i.test(expectedSourceSha ?? ''))
    throw new Error('INT01_EXPECTED_SOURCE_SHA_INVALID');
  const byProvider = new Map(trace.map(event => [event.provider, event]));
  if (byProvider.size !== trace.length) throw new Error('INT01_PROVIDER_TRACE_DUPLICATE');
  const operationIds = new Set();
  const correlations = new Set();
  for (const provider of requiredProviders) {
    const event = byProvider.get(provider);
    if (!event || event.started !== true || event.queried !== true || event.participated !== true)
      throw new Error('INT01_PROVIDER_NOT_EFFECTIVELY_PARTICIPATING');
    if (event.simulated === true) throw new Error('INT01_PROVIDER_SIMULATED');
    if (event.identityAuthorized !== true) throw new Error('INT01_PROVIDER_AUTHORIZATION_UNVERIFIED');
    if (!/^[0-9a-f]{40}$/i.test(event.sourceSha ?? '') || !event.operationId || !event.correlationId)
      throw new Error('INT01_PROVIDER_PROVENANCE_INVALID');
    if (event.sourceSha.toLowerCase() !== expectedSourceSha.toLowerCase())
      throw new Error('INT01_PROVIDER_SOURCE_SHA_MISMATCH');
    operationIds.add(event.operationId);
    correlations.add(event.correlationId);
  }
  if (operationIds.size !== 1 || correlations.size !== 1) throw new Error('INT01_PROVIDER_TRACE_NOT_CORRELATED');
  return { providers: requiredProviders, operationId: [...operationIds][0], correlationId: [...correlations][0] };
}
