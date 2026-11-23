// Offline generation from the official OpenAPI converted to JSON by a YAML parser.
// For one route, pass its operationId as the third argument; its complete
// contract-derived metadata is refreshed without touching other routes.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const operationId = process.argv[3];
const add = process.argv[4] === '--add';
if (!operationId)
  throw new Error(
    'An operationId is required; full contract route regeneration is disabled.',
  );

const spec = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const adminCandidates = {
  '0.6.0-h4-combos-admin': {
    method: 'POST',
    service: 'combos-svc',
    path: /^\/api\/v1\/combos\/administracion$/,
  },
  '0.6.0-h4-price-audit-admin': {
    service: 'price-audit-svc',
    path: /^\/api\/v1\/auditoria-precios\/administracion(?:\/\{auditId\})?$/,
  },
  '0.6.0-h4-inventory-admin': {
    service: 'inventory-svc',
    path: /^\/api\/v1\/inventario\/administracion\/saldos$/,
  },
  '0.6.0-h4-catalog-admin': {
    service: 'catalog-svc',
    path: /^\/api\/v1\/productos\/administracion(?:\/\{productoId\}|\/skus\/resolver)?$/,
  },
  '0.6.0-rc.5': {
    method: 'POST',
    service: 'catalog-svc',
    path: /^\/api\/v1\/productos\/administracion\/skus\/resolver$/,
  },
  '0.6.0-h4-pricing-admin': {
    service: 'pricing-svc',
    path: /^\/api\/v1\/precios\/administracion\/(?:productos\/\{productoId\}|skus\/\{sku\})$/,
  },
  '0.7.0-rc.3': {
    method: 'GET',
    service: 'bulk-svc',
    path: /^\/api\/v1\/carga-masiva\/productos\/importaciones\/por-correlacion\/\{correlationId\}$/,
    operationId: 'conciliarImportacionGeneralPorCorrelacion',
    security: ['userBearer'],
  },
};
const candidate = adminCandidates[spec.info.version];
if (
  (add
    ? !candidate
    : ![
        '0.6.0-rc.2',
        '0.6.0-rc.3',
        '0.6.0-rc.4',
        '0.6.0-rc.5',
        '0.7.0-rc.3',
      ].includes(spec.info.version)) ||
  spec.servers[0].url !== '/api/v1'
) {
  throw new Error('Unexpected contract version or base path');
}
const owners = {
  productos: 'catalog-svc',
  categorias: 'taxonomy-svc',
  marcas: 'taxonomy-svc',
  caracteristicas: 'taxonomy-svc',
  'tipos-producto': 'taxonomy-svc',
  taxonomia: 'taxonomy-svc',
  seo: 'taxonomy-svc',
  precios: 'pricing-svc',
  'auditoria-precios': 'price-audit-svc',
  promociones: 'promotions-svc',
  cupones: 'promotions-svc',
  recomendaciones: 'promotions-svc',
  combos: 'combos-svc',
  inventario: 'inventory-svc',
  'carga-masiva': 'bulk-svc',
};
function dereference(value) {
  if (!value?.$ref) return value;
  if (!value.$ref.startsWith('#/')) throw new Error('External ref unsupported');
  return value.$ref
    .slice(2)
    .split('/')
    .reduce((node, key) => node[key], spec);
}
const routes = [];
for (const [path, item] of Object.entries(spec.paths)) {
  for (const [method, operation] of Object.entries(item)) {
    if (
      !['get', 'post', 'put', 'patch', 'delete', 'head', 'options'].includes(
        method,
      )
    )
      continue;
    if (operation.operationId !== operationId) continue;
    const service = owners[path.split('/')[1]];
    if (
      !service ||
      !operation.operationId ||
      !Array.isArray(operation.security)
    ) {
      throw new Error(`Incomplete route ${method} ${path}`);
    }
    const security = operation.security.map((alternative) => {
      const schemes = Object.keys(alternative);
      if (
        schemes.length !== 1 ||
        !['serviceBearer', 'userBearer'].includes(schemes[0])
      ) {
        throw new Error('Unsupported security expression');
      }
      return schemes[0];
    });
    const parameters = [
      ...(item.parameters || []),
      ...(operation.parameters || []),
    ].map(dereference);
    const declaredErrorCodes = operation['x-error-codes'] ?? {};
    if (
      typeof declaredErrorCodes !== 'object' ||
      Array.isArray(declaredErrorCodes)
    ) {
      throw new Error(`Missing x-error-codes for ${operationId}`);
    }
    for (const [status, codes] of Object.entries(declaredErrorCodes)) {
      const rawResponse = operation.responses[status];
      if (!rawResponse || !Array.isArray(codes) || codes.length === 0) {
        throw new Error(
          `Invalid x-error-codes entry ${status} for ${operationId}`,
        );
      }
      const response = dereference(rawResponse);
      if (
        !response.content?.['application/problem+json'] ||
        codes.some(
          (code) => typeof code !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(code),
        ) ||
        new Set(codes).size !== codes.length
      ) {
        throw new Error(
          `Invalid x-error-codes entry ${status} for ${operationId}`,
        );
      }
    }
    routes.push({
      method: method.toUpperCase(),
      path: '/api/v1' + path,
      operationId: operation.operationId,
      service,
      security,
      scope: operation['x-required-scope'],
      audience: operation['x-service-audience'],
      clients: operation['x-allowed-client-ids'],
      role: operation['x-required-role'],
      introspection: operation['x-auth-validation'] === 'introspection',
      headers: parameters
        .filter((p) => p.in === 'header')
        .map((p) => ({
          name: p.name.toLowerCase(),
          required: !!p.required,
          minLength: p.schema?.minLength,
          maxLength: p.schema?.maxLength,
        })),
      requestTypes: Object.keys(
        dereference(operation.requestBody)?.content || {},
      ),
      responses: Object.fromEntries(
        Object.entries(operation.responses).map(([status, raw]) => {
          const response = dereference(raw);
          const codes = declaredErrorCodes[status] ?? [];
          return [
            status,
            {
              types: Object.keys(response.content || {}),
              codes,
              headers: Object.keys(response.headers || {}).map((h) =>
                h.toLowerCase(),
              ),
            },
          ];
        }),
      ),
    });
  }
}
if (routes.length !== 1)
  throw new Error(
    `Expected one operation ${operationId}; found ${routes.length}`,
  );
let output = fileURLToPath(
  new URL('../src/routing/contract-routes.ts', import.meta.url),
);
let existing = readFileSync(output, 'utf8');
const replacement = routes[0];
function tsQuote(value) {
  return `'${String(value).replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
}
function serializeRoute(route) {
  const properties = [
    `method: ${tsQuote(route.method)}`,
    `path: ${tsQuote(route.path)}`,
    `operationId: ${tsQuote(route.operationId)}`,
    `service: ${tsQuote(route.service)}`,
    `security: [${route.security.map(tsQuote).join(', ')}]`,
  ];
  for (const name of ['scope', 'audience', 'clients', 'role']) {
    const value = route[name];
    if (value !== undefined)
      properties.push(
        `${name}: ${Array.isArray(value) ? `[${value.map(tsQuote).join(', ')}]` : tsQuote(value)}`,
      );
  }
  properties.push(`introspection: ${route.introspection}`);
  const headers = route.headers.map((header) => {
    const fields = [
      `name: ${tsQuote(header.name)}`,
      `required: ${header.required}`,
    ];
    for (const name of ['minLength', 'maxLength'])
      if (header[name] !== undefined) fields.push(`${name}: ${header[name]}`);
    return `      { ${fields.join(', ')} }`;
  });
  properties.push(
    `headers: [${headers.length ? `\n${headers.join(',\n')}\n    ` : ''}]`,
  );
  properties.push(
    `requestTypes: [${route.requestTypes.map(tsQuote).join(', ')}]`,
  );
  const responses = Object.entries(route.responses).map(
    ([status, response]) =>
      `      ${tsQuote(status)}: { types: [${response.types.map(tsQuote).join(', ')}], codes: [${response.codes.map(tsQuote).join(', ')}], headers: [${response.headers.map(tsQuote).join(', ')}] }`,
  );
  properties.push(`responses: {\n${responses.join(',\n')}\n    }`);
  return `{\n${properties.map((property) => `  ${property}`).join(',\n')}\n}`;
}
if (add) {
  const { CONTRACT_ROUTES } = await import(pathToFileURL(output).href);
  const shape = (path) => path.replace(/\{[^}]+\}/g, '{}');
  if (
    candidate.operationId !== operationId ||
    replacement.method !== (candidate.method ?? 'GET') ||
    replacement.service !== candidate.service ||
    JSON.stringify(replacement.security) !==
      JSON.stringify(candidate.security ?? ['userBearer']) ||
    replacement.role !== (candidate.role ?? undefined) ||
    !candidate.path.test(replacement.path) ||
    CONTRACT_ROUTES.some(
      (route) =>
        route.operationId === operationId ||
        (route.method === replacement.method &&
          shape(route.path) === shape(replacement.path)),
    )
  )
    throw new Error(`Cannot add candidate operation ${operationId}`);
  const end = existing.lastIndexOf('\n];');
  if (end < 0) throw new Error('Could not locate route registry terminator');
  writeFileSync(
    output,
    existing.slice(0, end) +
      '\n  ' +
      serializeRoute(replacement) +
      ',' +
      existing.slice(end),
  );
  console.log(`Added ${operationId} from candidate OpenAPI.`);
  process.exit(0);
}
const marker = `operationId: '${operationId}'`;
let operationPosition = existing.indexOf(marker);
if (operationPosition < 0) {
  const overlayOutput = fileURLToPath(
    new URL('../src/routing/g5-h5-routes.ts', import.meta.url),
  );
  const overlay = readFileSync(overlayOutput, 'utf8');
  const overlayPosition = overlay.indexOf(marker);
  if (overlayPosition >= 0) {
    output = overlayOutput;
    existing = overlay;
    operationPosition = overlayPosition;
  }
}
if (operationPosition < 0) throw new Error(`Unknown operation ${operationId}`);
const objectStart = existing.lastIndexOf('\n  {', operationPosition) + 3;
let depth = 0;
let quote;
let escaped = false;
let objectEnd = -1;
for (let i = objectStart; i < existing.length; i++) {
  const character = existing[i];
  if (quote) {
    if (escaped) escaped = false;
    else if (character === '\\') escaped = true;
    else if (character === quote) quote = undefined;
    continue;
  }
  if (character === "'" || character === '"') quote = character;
  else if (character === '{') depth++;
  else if (character === '}' && --depth === 0) {
    objectEnd = i + 1;
    break;
  }
}
if (objectEnd < 0) throw new Error('Could not locate existing route object');
const existingRoute = existing.slice(objectStart, objectEnd);
for (const [name, expected] of [
  ['method', replacement.method],
  ['path', replacement.path],
  ['service', replacement.service],
]) {
  if (!existingRoute.includes(`${name}: ${tsQuote(expected)}`))
    throw new Error(
      `Refusing to change ${name} for ${operationId}: ${existingRoute.slice(0, 120)}`,
    );
}
writeFileSync(
  output,
  `// Generated from Docs OpenAPI ${spec.info.version}; focused update: ${operationId}.\n` +
    existing.slice(existing.indexOf('\n') + 1, objectStart) +
    serializeRoute(replacement) +
    existing.slice(objectEnd),
);
console.log(`Updated ${operationId} only.`);
