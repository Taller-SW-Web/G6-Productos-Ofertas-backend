export const DOCS_SHA = '40524e96c6973f84d74160076781702fe2a3da19';
export const CONTRACT_VERSION = '0.7.0-rc.3';

export const CONTRACT_OPERATIONS = Object.freeze([
  { id: 'catalog-admin-list', method: 'GET', path: '/productos/administracion', success: 200, owner: 'catalog-svc', statuses: [200, 400, 401, 403, 500, 503] },
  { id: 'catalog-commercial-list', method: 'GET', path: '/productos?canal={channel}&pagina={page}&tamanio={pageSize}', success: 200, owner: 'catalog-svc', statuses: [200, 400, 401, 403, 429, 500, 503] },
  { id: 'catalog-commercial-detail', method: 'GET', path: '/productos/{productoId}?canal={channel}', success: 200, owner: 'catalog-svc', statuses: [200, 400, 401, 403, 404, 429, 500, 503] },
  { id: 'catalog-product-create', method: 'POST', path: '/productos', success: 201, owner: 'catalog-svc', requestBody: true, statuses: [201, 400, 401, 403, 409, 422, 500, 503] },
  { id: 'catalog-product-edit', method: 'PATCH', path: '/productos/{productoId}', success: 200, owner: 'catalog-svc', requestBody: true, statuses: [200, 400, 401, 403, 404, 409, 422, 500, 503] },
  { id: 'catalog-product-activate', method: 'POST', path: '/productos/{productoId}/activar', success: 200, owner: 'catalog-svc', statuses: [200, 400, 401, 403, 404, 409, 422, 500, 503] },
  { id: 'catalog-preparation-read', method: 'GET', path: '/productos/{productoId}/preparacion', success: 200, owner: 'catalog-svc', statuses: [200, 400, 401, 403, 404, 500, 503] },
  { id: 'catalog-preparation-retry', method: 'POST', path: '/productos/{productoId}/preparacion/reintentar', success: 202, owner: 'catalog-svc', requestBody: true, statuses: [202, 400, 401, 403, 404, 409, 500, 503] },
  { id: 'pricing-effective-read', method: 'GET', path: '/precios/skus/{sku}?canal={channel}', success: 200, owner: 'pricing-svc', statuses: [200, 400, 401, 403, 404, 429, 500, 503] },
  { id: 'pricing-update', method: 'PATCH', path: '/precios/skus/{sku}', success: 200, owner: 'pricing-svc', requestBody: true, statuses: [200, 400, 401, 403, 404, 409, 422, 500, 503] },
  { id: 'inventory-availability-read', method: 'GET', path: '/inventario/disponibilidad?skus={sku}', success: 200, owner: 'inventory-svc', statuses: [200, 400, 401, 403, 500, 503] },
]);

const TERMINAL = new Set(['COMPLETED', 'REJECTED']);
const DEPENDENCY_STATES = new Set(['PENDING', 'COMPLETED', 'REJECTED']);

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const requireString = (value, code) => { if (typeof value !== 'string' || value.length === 0) throw new Error(code); };
const requireNonNegativeInteger = (value, code) => { if (!Number.isSafeInteger(value) || value < 0) throw new Error(code); };

function validateProductSummary(body, { administrative = false, detail = false } = {}) {
  for (const field of ['product_id', 'slug', 'name', 'categoria_id', 'tipo_producto_id', 'marca_id']) requireString(body?.[field], 'INT01_PRODUCT_RESPONSE_INVALID');
  if (typeof body?.tiene_variantes !== 'boolean') throw new Error('INT01_PRODUCT_RESPONSE_INVALID');
  if (administrative && !['BORRADOR', 'ACTIVO', 'INACTIVO'].includes(body?.status)) throw new Error('INT01_PRODUCT_STATUS_INVALID');
  if (body?.sku_base !== undefined && body.sku_base !== null && typeof body.sku_base !== 'string') throw new Error('INT01_PRODUCT_SKU_INVALID');
  if (detail) {
    if (!Array.isArray(body.variants)) throw new Error('INT01_PRODUCT_VARIANTS_INVALID');
    for (const variant of body.variants) {
      requireString(variant?.variant_id, 'INT01_PRODUCT_VARIANT_INVALID');
      requireString(variant?.sku, 'INT01_PRODUCT_VARIANT_INVALID');
    }
  }
}

function validatePreparationBody(body) {
  requireString(body?.product_id, 'INT01_PREPARATION_BODY_INVALID');
  if (typeof body?.tiene_variantes !== 'boolean' || !Array.isArray(body?.variantes)) throw new Error('INT01_PREPARATION_BODY_INVALID');
  const states = [];
  const addDependency = dependency => {
    if (!isRecord(dependency) || !DEPENDENCY_STATES.has(dependency.status) || typeof dependency.manual_retry_allowed !== 'boolean')
      throw new Error('INT01_PREPARATION_DEPENDENCY_INVALID');
    states.push(dependency.status);
  };
  addDependency(body.pricing);
  if (body.tiene_variantes) {
    if (body.inventario !== null) throw new Error('INT01_PREPARATION_INVENTORY_SHAPE_INVALID');
    for (const variant of body.variantes) {
      requireString(variant?.variant_id, 'INT01_PREPARATION_VARIANT_INVALID');
      requireString(variant?.sku, 'INT01_PREPARATION_VARIANT_INVALID');
      addDependency(variant.inventario);
    }
  } else {
    addDependency(body.inventario);
    if (body.variantes.length !== 0) throw new Error('INT01_PREPARATION_VARIANTS_SHAPE_INVALID');
  }
  return states;
}

function validateRequestPath(template, path) {
  let actual;
  try { actual = new URL(path, 'http://h5.contract.invalid'); } catch { throw new Error('INT01_REQUEST_PATH_INVALID'); }
  const templatePath = template.split('?')[0];
  const expressionSource = templatePath.split(/(\{[^/]+\})/g).map(part =>
    part.startsWith('{') && part.endsWith('}') ? '[^/]+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
  ).join('');
  const expression = new RegExp(`^${expressionSource}$`);
  if (!expression.test(actual.pathname)) throw new Error('INT01_REQUEST_PATH_MISMATCH');
  const queryTemplate = template.includes('?') ? template.slice(template.indexOf('?') + 1) : '';
  for (const part of queryTemplate.split('&').filter(Boolean)) {
    const key = part.split('=')[0];
    if (!actual.searchParams.get(key)) throw new Error('INT01_REQUIRED_QUERY_MISSING');
  }
  return actual;
}

function validateSuccessResponse(operationId, request, response) {
  const body = response.body;
  if (!isRecord(body)) throw new Error('INT01_RESPONSE_BODY_INVALID');
  if ([
    'catalog-product-create', 'catalog-product-edit', 'catalog-product-activate',
  ].includes(operationId)) {
    validateProductSummary(body, { administrative: true, detail: true });
    requireNonNegativeInteger(body.catalog_version, 'INT01_PRODUCT_VERSION_INVALID');
  } else if (operationId === 'catalog-commercial-list') {
    if (!Array.isArray(body.items) || !Number.isSafeInteger(body.pagina) || !Number.isSafeInteger(body.tamanio) || !Number.isSafeInteger(body.total)) throw new Error('INT01_COMMERCIAL_PAGE_INVALID');
    if (body.pagina !== Number(new URL(request.path, 'http://h5.contract.invalid').searchParams.get('pagina')) || body.tamanio !== Number(new URL(request.path, 'http://h5.contract.invalid').searchParams.get('tamanio')) || body.total < body.items.length) throw new Error('INT01_COMMERCIAL_PAGE_METADATA_INVALID');
    for (const item of body.items) validateProductSummary(item);
  } else if (operationId === 'catalog-commercial-detail') {
    validateProductSummary(body, { detail: true });
    if (!isRecord(body.marca) || typeof body.marca.marca_id !== 'string' || typeof body.marca.name !== 'string' || !['ACTIVA', 'INACTIVA'].includes(body.marca.status)) throw new Error('INT01_COMMERCIAL_BRAND_INVALID');
  } else if (operationId === 'catalog-preparation-read') {
    validatePreparationBody(body);
  } else if (operationId === 'catalog-preparation-retry') {
    if (body.status !== 'ACCEPTED' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.operation_id ?? '') || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.correlation_id ?? '')) throw new Error('INT01_ACCEPTED_RESPONSE_INVALID');
  } else if (operationId === 'pricing-effective-read' || operationId === 'pricing-update') {
    requireString(body.sku, 'INT01_PRICE_RESPONSE_INVALID');
    if (typeof body.precio_regular !== 'number' || !Number.isFinite(body.precio_regular) || body.precio_regular <= 0) throw new Error('INT01_PRICE_RESPONSE_INVALID');
    requireString(body.currency, 'INT01_PRICE_RESPONSE_INVALID');
    if (!(body.channel_id === null || ['MARKETPLACE', 'CHATBOT', 'RETAIL', 'VENTAS'].includes(body.channel_id))) throw new Error('INT01_PRICE_CHANNEL_INVALID');
    requireString(body.valid_from, 'INT01_PRICE_RESPONSE_INVALID');
    requireNonNegativeInteger(body.price_version, 'INT01_PRICE_RESPONSE_INVALID');
    requireString(body.vigencia_id, 'INT01_PRICE_RESPONSE_INVALID');
    if (!['PRODUCTO', 'SKU_OVERRIDE'].includes(body.origen)) throw new Error('INT01_PRICE_RESPONSE_INVALID');
  } else if (operationId === 'inventory-availability-read') {
    if (!Array.isArray(body.items)) throw new Error('INT01_INVENTORY_RESPONSE_INVALID');
    for (const item of body.items) {
      requireString(item?.sku, 'INT01_INVENTORY_ITEM_INVALID');
      for (const field of ['on_hand', 'reserved', 'blocked', 'available']) requireNonNegativeInteger(item[field], 'INT01_INVENTORY_NEGATIVE_BALANCE');
      if (!['DISPONIBLE', 'STOCK_BAJO', 'AGOTADO'].includes(item.status)) throw new Error('INT01_INVENTORY_STATUS_INVALID');
      if (item.available !== Math.max(item.on_hand - item.reserved - item.blocked, 0)) throw new Error('INT01_INVENTORY_BALANCE_INCONSISTENT');
    }
  }
}

export function replayContractExchange(exchange) {
  const operation = CONTRACT_OPERATIONS.find(item => item.id === exchange?.operationId);
  if (!operation) throw new Error('INT01_OPERATION_NOT_IN_DOCS');
  if (exchange.request?.method !== operation.method) throw new Error('INT01_REQUEST_METHOD_MISMATCH');
  validateRequestPath(operation.path, exchange.request.path);
  if (operation.requestBody && !isRecord(exchange.request.body)) throw new Error('INT01_REQUEST_BODY_REQUIRED');
  if (!Number.isInteger(exchange.response?.status) || !operation.statuses.includes(exchange.response.status)) throw new Error('INT01_RESPONSE_STATUS_NOT_IN_DOCS');
  if (!isRecord(exchange.response.body)) throw new Error('INT01_RESPONSE_BODY_INVALID');
  if (exchange.response.status === operation.success) validateSuccessResponse(operation.id, exchange.request, exchange.response);
  else if (exchange.response.body.status !== exchange.response.status || typeof exchange.response.body.code !== 'string') throw new Error('INT01_PROBLEM_RESPONSE_INVALID');
  return structuredClone(exchange.response);
}

export function classifyPreparationResponse(httpStatus, body, operationId) {
  if (httpStatus === 202) {
    if (
      operationId !== 'catalog-preparation-retry' ||
      body?.status !== 'ACCEPTED' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body?.operation_id ?? '') ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body?.correlation_id ?? '')
    )
      throw new Error('INT01_ACCEPTED_RESPONSE_INVALID');
    return { state: 'PENDING', terminal: false };
  }
  if (httpStatus !== 200 || operationId !== 'catalog-preparation-read')
    throw new Error('INT01_PREPARATION_HTTP_STATUS_INVALID');
  const states = validatePreparationBody(body);
  if (states.includes('PENDING')) return { state: 'PENDING', terminal: false };
  const state = states.includes('REJECTED') ? 'REJECTED' : 'COMPLETED';
  return { state, terminal: TERMINAL.has(state) };
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
