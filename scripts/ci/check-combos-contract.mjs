#!/usr/bin/env node
/**
 * Compara las operaciones de Combos del OpenAPI oficial (0.7.0-rc.3) con las rutas
 * declaradas en api-gateway, los decoradores y seguridad de NestJS en combos-svc,
 * los DTOs/respuestas del servicio (incluida la disponibilidad conservadora) y las pruebas.
 * Uso: node scripts/ci/check-combos-contract.mjs <openapi.yaml>
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import ts from 'typescript';

const root = process.cwd();
const contractPath = process.argv[2]
  ? resolve(process.argv[2])
  : resolve(root, '../docs/contratos/http/openapi.yaml');
const contractText = readFileSync(contractPath, 'utf8');

const versionMatch = /^  version:\s*([^\s#]+)\s*$/m.exec(contractText);
const contractVersion = versionMatch?.[1] ?? '';
if (contractVersion !== '0.7.0-rc.3') {
  throw new Error(
    `Versión OpenAPI inesperada para Combos H5: ${contractVersion || 'ausente'} (esperada: 0.7.0-rc.3)`,
  );
}

const combosPath = (path) => /^\/combos(?:\/|$)/.test(path);
const operations = [];
let currentPath;
let current;
let inPaths = false;
let inSecurity = false;
let inResponses = false;
for (const line of contractText.split(/\r?\n/)) {
  if (/^paths:\s*$/.test(line)) {
    inPaths = true;
    continue;
  }
  if (!inPaths) continue;
  if (/^components:\s*$/.test(line)) break;
  const pathMatch = /^  (\/[^:]+):\s*$/.exec(line);
  if (pathMatch) {
    currentPath = pathMatch[1];
    current = undefined;
    inSecurity = false;
    inResponses = false;
    continue;
  }
  const methodMatch = /^    (get|post|put|patch|delete|head|options):\s*$/.exec(
    line,
  );
  if (methodMatch && currentPath && combosPath(currentPath)) {
    current = {
      method: methodMatch[1].toUpperCase(),
      path: `/api/v1${currentPath}`,
      security: [],
      responses: [],
    };
    operations.push(current);
    inSecurity = false;
    inResponses = false;
    continue;
  }
  if (!current) continue;
  if (/^      [A-Za-z0-9_-]+:/.test(line)) {
    inSecurity = /^      security:\s*$/.test(line);
    inResponses = /^      responses:\s*$/.test(line);
  }
  const idMatch = /^      operationId:\s*([A-Za-z0-9_]+)\s*$/.exec(line);
  if (idMatch) current.operationId = idMatch[1];
  const roleMatch = /^      x-required-role:\s*([A-Za-z0-9_]+)\s*$/.exec(line);
  if (roleMatch) current.requiredRole = roleMatch[1];
  const scopeMatch = /^      x-required-scope:\s*([A-Za-z0-9_:.-]+)\s*$/.exec(
    line,
  );
  if (scopeMatch) current.requiredScope = scopeMatch[1];
  const audienceMatch =
    /^      x-service-audience:\s*([A-Za-z0-9_.-]+)\s*$/.exec(line);
  if (audienceMatch) current.serviceAudience = audienceMatch[1];
  if (inSecurity) {
    const secMatch = /^      - ([A-Za-z0-9_]+):\s*\[\]\s*$/.exec(line);
    if (secMatch) current.security.push(secMatch[1]);
  }
  if (inResponses) {
    const resMatch = /^        '(\d{3})':\s*$/.exec(line);
    if (resMatch) current.responses.push(resMatch[1]);
  }
}

const expectedRoutes = [
  'GET /api/v1/combos',
  'POST /api/v1/combos',
  'POST /api/v1/combos/administracion',
  'GET /api/v1/combos/{comboId}',
  'PATCH /api/v1/combos/{comboId}',
  'POST /api/v1/combos/{comboId}/desactivar',
  'GET /api/v1/combos/{comboId}/disponibilidad',
];

for (const operation of operations) {
  if (!operation.operationId) {
    throw new Error(
      `OpenAPI sin operationId: ${operation.method} ${operation.path}`,
    );
  }
}

const normalize = (path) =>
  `/${path
    .replace(/^\/+/, '')
    .replace(/:([A-Za-z0-9_]+)/g, '{$1}')
    .replace(/\/+$/, '')}`;
const key = (method, path) => `${method.toUpperCase()} ${normalize(path)}`;

function propertyAssignment(node, name) {
  if (!ts.isObjectLiteralExpression(node)) return undefined;
  return node.properties.find(
    (item) =>
      ts.isPropertyAssignment(item) &&
      item.name &&
      ((ts.isIdentifier(item.name) && item.name.text === name) ||
        (ts.isStringLiteral(item.name) && item.name.text === name)),
  );
}

function stringProperty(node, name) {
  const property = propertyAssignment(node, name);
  return property &&
    (ts.isStringLiteral(property.initializer) ||
      ts.isNoSubstitutionTemplateLiteral(property.initializer))
    ? property.initializer.text
    : undefined;
}

function stringArrayProperty(node, name) {
  const property = propertyAssignment(node, name);
  if (!property || !ts.isArrayLiteralExpression(property.initializer)) {
    return undefined;
  }
  return property.initializer.elements
    .filter(
      (el) => ts.isStringLiteral(el) || ts.isNoSubstitutionTemplateLiteral(el),
    )
    .map((el) => el.text);
}

const gatewayPath = resolve(
  root,
  'apps/api-gateway/src/routing/contract-routes.ts',
);
const gatewaySource = ts.createSourceFile(
  gatewayPath,
  readFileSync(gatewayPath, 'utf8'),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
);
const gateway = [];
function visitGateway(node) {
  if (
    ts.isObjectLiteralExpression(node) &&
    stringProperty(node, 'service') === 'combos-svc'
  ) {
    const method = stringProperty(node, 'method');
    const path = stringProperty(node, 'path');
    const operationId = stringProperty(node, 'operationId');
    const security = stringArrayProperty(node, 'security') ?? [];
    const role = stringProperty(node, 'role');
    const scope = stringProperty(node, 'scope');
    const audience = stringProperty(node, 'audience');
    const headersProp = propertyAssignment(node, 'headers');
    const requiredHeaders = [];
    if (headersProp && ts.isArrayLiteralExpression(headersProp.initializer)) {
      for (const h of headersProp.initializer.elements) {
        if (ts.isObjectLiteralExpression(h)) {
          const hName = stringProperty(h, 'name');
          const reqProp = propertyAssignment(h, 'required');
          const isReq = reqProp?.initializer.kind === ts.SyntaxKind.TrueKeyword;
          if (hName && isReq) requiredHeaders.push(hName);
        }
      }
    }
    if (method && path && operationId) {
      gateway.push({
        method,
        path,
        operationId,
        security,
        role,
        scope,
        audience,
        requiredHeaders,
      });
    }
  }
  ts.forEachChild(node, visitGateway);
}
visitGateway(gatewaySource);

const controllerPath = resolve(
  root,
  'apps/combos-svc/src/combos-svc.controller.ts',
);
const controllerSource = ts.createSourceFile(
  controllerPath,
  readFileSync(controllerPath, 'utf8'),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
);
const routeDecorators = new Map([
  ['Get', 'GET'],
  ['Post', 'POST'],
  ['Put', 'PUT'],
  ['Patch', 'PATCH'],
  ['Delete', 'DELETE'],
  ['Head', 'HEAD'],
  ['Options', 'OPTIONS'],
]);
const literal = (node) =>
  node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : '';
const runtime = [];
for (const statement of controllerSource.statements) {
  if (!ts.isClassDeclaration(statement)) continue;
  for (const member of statement.members) {
    if (!ts.isMethodDeclaration(member) || !member.modifiers) continue;
    let method;
    let routePath;
    let httpCode;
    let access;
    for (const decorator of member.modifiers.filter(ts.isDecorator)) {
      const expr = decorator.expression;
      if (!ts.isCallExpression(expr) || !ts.isIdentifier(expr.expression))
        continue;
      const decName = expr.expression.text;
      if (routeDecorators.has(decName)) {
        method = routeDecorators.get(decName);
        routePath = literal(expr.arguments[0]);
      } else if (decName === 'HttpCode' && expr.arguments[0]) {
        httpCode = Number(expr.arguments[0].getText(controllerSource));
      } else if (
        decName === 'RequireComboAccess' &&
        expr.arguments[0] &&
        ts.isObjectLiteralExpression(expr.arguments[0])
      ) {
        const arg = expr.arguments[0];
        access = {
          operationId: stringProperty(arg, 'operationId'),
          identity: stringProperty(arg, 'identity'),
          allowedRoles: stringArrayProperty(arg, 'allowedRoles') ?? [],
          scope: stringProperty(arg, 'scope'),
        };
      }
    }
    if (!method || !routePath || !routePath.startsWith('combos')) continue;
    runtime.push({
      method,
      path: normalize(`/api/v1/${routePath}`),
      httpCode,
      access,
    });
  }
}

const servicePath = resolve(root, 'apps/combos-svc/src/combos-svc.service.ts');
const serviceText = readFileSync(servicePath, 'utf8');
const serviceSource = ts.createSourceFile(
  servicePath,
  serviceText,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
);

const failures = [];

const opKeys = new Set(operations.map((o) => key(o.method, o.path)));
for (const reqRoute of expectedRoutes) {
  if (!opKeys.has(reqRoute)) {
    failures.push(`OpenAPI: falta ruta requerida ${reqRoute}`);
  }
}

function differences(expected, actual, label) {
  const found = new Set(actual.map((item) => key(item.method, item.path)));
  return expected
    .filter((item) => !found.has(key(item.method, item.path)))
    .map(
      (item) =>
        `${label}: falta ${item.operationId} (${item.method} ${item.path})`,
    );
}
const extras = (label, expected, actual) => {
  const found = new Set(expected.map((item) => key(item.method, item.path)));
  return actual
    .filter((item) => !found.has(key(item.method, item.path)))
    .map(
      (item) =>
        `${label}: ruta Combos fuera del OpenAPI (${item.method} ${item.path})`,
    );
};

failures.push(...differences(operations, gateway, 'Gateway'));
failures.push(...differences(operations, runtime, 'NestJS'));
failures.push(...extras('Gateway', operations, gateway));
failures.push(...extras('NestJS', operations, runtime));

for (const op of operations) {
  const opKey = key(op.method, op.path);
  const gw = gateway.find((r) => key(r.method, r.path) === opKey);
  if (gw) {
    if (gw.operationId !== op.operationId) {
      failures.push(
        `Gateway: operationId distinto en ${opKey} (${gw.operationId} != ${op.operationId})`,
      );
    }
    if (
      JSON.stringify([...gw.security].sort()) !==
      JSON.stringify([...op.security].sort())
    ) {
      failures.push(
        `Gateway: security distinto en ${op.operationId} (${gw.security.join(',')} != ${op.security.join(',')})`,
      );
    }
    if ((gw.role ?? undefined) !== (op.requiredRole ?? undefined)) {
      failures.push(
        `Gateway: x-required-role distinto en ${op.operationId} (${gw.role} != ${op.requiredRole})`,
      );
    }
    if ((gw.scope ?? undefined) !== (op.requiredScope ?? undefined)) {
      failures.push(
        `Gateway: x-required-scope distinto en ${op.operationId} (${gw.scope} != ${op.requiredScope})`,
      );
    }
    if (
      op.operationId === 'crearComboAdministracion' &&
      !gw.requiredHeaders.includes('idempotency-key')
    ) {
      failures.push(
        `Gateway: crearComboAdministracion debe exigir cabecera idempotency-key`,
      );
    }
  }

  const rt = runtime.find((r) => key(r.method, r.path) === opKey);
  if (rt) {
    if (!rt.access || rt.access.operationId !== op.operationId) {
      failures.push(
        `NestJS: @RequireComboAccess operationId inválido en ${opKey} (${rt.access?.operationId} != ${op.operationId})`,
      );
    } else {
      const expectedIdentity = op.security.includes('serviceBearer')
        ? 'user_or_service'
        : 'user';
      if (rt.access.identity !== expectedIdentity) {
        failures.push(
          `NestJS: identity distinto en ${op.operationId} (${rt.access.identity} != ${expectedIdentity})`,
        );
      }
      if (
        op.requiredRole &&
        !rt.access.allowedRoles.includes(op.requiredRole)
      ) {
        failures.push(
          `NestJS: allowedRoles en ${op.operationId} no incluye ${op.requiredRole}`,
        );
      }
      if ((rt.access.scope ?? undefined) !== (op.requiredScope ?? undefined)) {
        failures.push(
          `NestJS: scope distinto en ${op.operationId} (${rt.access.scope} != ${op.requiredScope})`,
        );
      }
    }
    if (op.operationId === 'desactivarCombo' && rt.httpCode !== 200) {
      failures.push(`NestJS: desactivarCombo debe declarar @HttpCode(200)`);
    }
  }
}

const interfaceProps = new Map();
function collectDto(node) {
  if (ts.isInterfaceDeclaration(node)) {
    const props = new Set(
      node.members
        .filter(ts.isPropertySignature)
        .map((m) => (ts.isIdentifier(m.name) ? m.name.text : '')),
    );
    interfaceProps.set(node.name.text, props);
  }
  ts.forEachChild(node, collectDto);
}
collectDto(serviceSource);

const comboInputProps = interfaceProps.get('ComboInput');
for (const prop of [
  'nombre',
  'descripcion',
  'componentes',
  'precioCombo',
  'version',
]) {
  if (!comboInputProps?.has(prop)) {
    failures.push(`DTO ComboInput: falta propiedad ${prop}`);
  }
}
const componentInputProps = interfaceProps.get('ComponentInput');
for (const prop of ['sku', 'cantidad']) {
  if (!componentInputProps?.has(prop)) {
    failures.push(`DTO ComponentInput: falta propiedad ${prop}`);
  }
}

for (const field of [
  'combo_id',
  'status',
  'price',
  'components',
  'informative_availability',
  'calculated_at',
  'freshness',
  'name',
  'description',
  'version',
]) {
  if (!new RegExp(`\\b${field}\\s*:`).test(serviceText)) {
    failures.push(`DTO Combo (wire): falta campo contractual ${field}`);
  }
}

const availMatch =
  /async\s+availability\s*\([^)]*\)\s*\{([\s\S]*?)^\s{2}\}/m.exec(serviceText);
if (!availMatch) {
  failures.push('Service: falta método availability');
} else {
  const body = availMatch[1];
  for (const invariant of [
    /verificable\s*:\s*false/,
    /cantidadInformativa\s*:\s*null/,
    /estadoActualizacion\s*:\s*'INCOMPLETA'/,
    /calculated_at\s*:/,
    /comboId\s*:/,
  ]) {
    if (!invariant.test(body)) {
      failures.push(
        `Disponibilidad conservadora: falta invariante ${invariant.source}`,
      );
    }
  }
}

function listFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory()
      ? listFiles(path)
      : /\.(spec|e2e-spec)\.ts$/.test(entry.name)
        ? [path]
        : [];
  });
}
const testsText = listFiles(resolve(root, 'apps/combos-svc'))
  .map((path) => readFileSync(path, 'utf8'))
  .join('\n');
for (const pattern of [
  '/api/v1/combos',
  '/administracion',
  '/desactivar',
  '/disponibilidad',
  'verificable: false',
  'cantidadInformativa: null',
  "estadoActualizacion: 'INCOMPLETA'",
]) {
  if (!testsText.includes(pattern)) {
    failures.push(
      `Pruebas Combos: falta verificación explícita para "${pattern}"`,
    );
  }
}

if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log(
    `PASS ${operations.length}/${operations.length} operaciones Combos (${contractVersion}): OpenAPI <-> Gateway <-> NestJS <-> DTO/disponibilidad <-> pruebas (${contractPath})`,
  );
}
