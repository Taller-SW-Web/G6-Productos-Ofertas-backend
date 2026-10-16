// Offline generation from the official OpenAPI converted to JSON by a YAML parser.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const spec = JSON.parse(readFileSync(process.argv[2], 'utf8'));
if (spec.info.version !== '0.6.0-rc.1' || spec.servers[0].url !== '/api/v1') {
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
          const codes =
            response.content?.[
              'application/problem+json'
            ]?.schema?.allOf?.flatMap((s) => s.properties?.code?.enum || []) ||
            [];
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
if (new Set(routes.map((r) => r.operationId)).size !== routes.length)
  throw new Error('Duplicate operationIds');
writeFileSync(
  fileURLToPath(new URL('../src/routing/contract-routes.ts', import.meta.url)),
  '// Generated from Docs c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b; OpenAPI blob f64bfe9a097b2a0f74c2600988305443d92f640e.\n' +
    "import type { ContractRoute } from './contract-route.js';\n" +
    'export const CONTRACT_ROUTES: readonly ContractRoute[] = ' +
    JSON.stringify(routes, null, 2) +
    ';\n',
);
console.log(
  `Generated ${routes.length} operations from ${Object.keys(spec.paths).length} contract paths.`,
);
