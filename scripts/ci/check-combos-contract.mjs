#!/usr/bin/env node
/**
 * Compara estáticamente las operaciones de Combos del OpenAPI oficial (0.7.0-rc.3)
 * con las rutas y respuestas declaradas en api-gateway, los decoradores y seguridad
 * de NestJS en combos-svc, los DTOs/respuestas del servicio (incluida la disponibilidad
 * conservadora) y las aserciones en pruebas. No ejecuta validación de runtime.
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

const lines = contractText.split(/\r?\n/);

// Recolectar anclas YAML de listas de códigos (p. ej. enum: &id102\n - TOKEN_INVALIDO)
const yamlListAnchors = new Map();
for (let i = 0; i < lines.length; i += 1) {
  const anchorMatch = /^(\s*)(?:[A-Za-z0-9_'".-]+:\s*)?&([A-Za-z0-9_]+)\s*$/.exec(
    lines[i],
  );
  if (!anchorMatch) continue;
  const baseIndent = anchorMatch[1].length;
  const anchorName = anchorMatch[2];
  const items = [];
  for (let j = i + 1; j < lines.length; j += 1) {
    const next = lines[j];
    if (!next.trim() || next.trim().startsWith('#')) continue;
    const itemMatch = /^(\s*)-\s+([^\s#]+)\s*$/.exec(next);
    if (itemMatch && itemMatch[1].length >= baseIndent) {
      items.push(itemMatch[2].replace(/^['"]|['"]$/g, ''));
      continue;
    }
    break;
  }
  if (items.length > 0) {
    yamlListAnchors.set(anchorName, items);
  }
}

const combosPath = (path) => /^\/combos(?:\/|$)/.test(path);
const operations = [];
let currentPath;
let current;
let inPaths = false;
let section = '';
let currentErrorStatus = '';

for (const line of lines) {
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
    section = '';
    currentErrorStatus = '';
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
      responses: new Set(),
      errorCodes: new Map(),
      errorCodeParseFailures: [],
    };
    operations.push(current);
    section = '';
    currentErrorStatus = '';
    continue;
  }
  if (!current) continue;

  if (/^      [A-Za-z0-9_-]+:/.test(line)) {
    section = /^      security:\s*$/.test(line)
      ? 'security'
      : /^      responses:\s*$/.test(line)
        ? 'responses'
        : /^      x-error-codes:\s*$/.test(line)
          ? 'x-error-codes'
          : '';
    currentErrorStatus = '';
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

  if (section === 'security') {
    const secMatch = /^      - ([A-Za-z0-9_]+):\s*\[\]\s*$/.exec(line);
    if (secMatch) current.security.push(secMatch[1]);
  } else if (section === 'responses') {
    const resMatch =
      /^        ['"]?(\d{3})['"]?:\s*(?:[*&][A-Za-z0-9_]+|\{.*\}|\S.*)?\s*$/.exec(
        line,
      );
    if (resMatch) {
      current.responses.add(resMatch[1]);
    }
  } else if (section === 'x-error-codes') {
    const errStatusMatch =
      /^        ['"]?(\d{3})['"]?:\s*(.*)$/.exec(line);
    if (errStatusMatch) {
      const status = errStatusMatch[1];
      const rhs = errStatusMatch[2].trim();
      currentErrorStatus = status;
      if (rhs.startsWith('*')) {
        const aliasName = rhs.slice(1).trim();
        const resolved = yamlListAnchors.get(aliasName);
        if (!resolved || resolved.length === 0) {
          current.errorCodeParseFailures.push(
            `OpenAPI: alias YAML '*${aliasName}' en x-error-codes (${status}) de ${current.method} ${current.path} no pudo resolverse`,
          );
        } else {
          current.errorCodes.set(status, [...resolved]);
        }
      } else if (rhs.startsWith('[') && rhs.endsWith(']')) {
        const inlineItems = rhs
          .slice(1, -1)
          .split(',')
          .map((item) => item.trim().replace(/^['"]|['"]$/g, ''))
          .filter(Boolean);
        current.errorCodes.set(status, inlineItems);
      } else {
        current.errorCodes.set(status, []);
      }
      continue;
    }
    if (currentErrorStatus) {
      const errItemMatch = /^        - ([^\s#]+)\s*$/.exec(line);
      if (errItemMatch) {
        current.errorCodes
          .get(currentErrorStatus)
          ?.push(errItemMatch[1].replace(/^['"]|['"]$/g, ''));
      }
    }
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
    const responses = new Map();
    const responsesProp = propertyAssignment(node, 'responses');
    if (
      responsesProp &&
      ts.isObjectLiteralExpression(responsesProp.initializer)
    ) {
      for (const prop of responsesProp.initializer.properties) {
        if (!ts.isPropertyAssignment(prop)) continue;
        const status = ts.isStringLiteral(prop.name)
          ? prop.name.text
          : ts.isIdentifier(prop.name)
            ? prop.name.text
            : '';
        if (!status || !ts.isObjectLiteralExpression(prop.initializer)) continue;
        responses.set(status, {
          types: stringArrayProperty(prop.initializer, 'types') ?? [],
          codes: stringArrayProperty(prop.initializer, 'codes') ?? [],
        });
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
        responses,
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
  failures.push(...op.errorCodeParseFailures);
  for (const [status, codes] of op.errorCodes.entries()) {
    if (codes.length === 0) {
      failures.push(
        `OpenAPI: x-error-codes vacío para HTTP ${status} en ${op.operationId} (${opKey})`,
      );
    }
  }
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

    for (const status of op.responses) {
      const gwResp = gw.responses.get(status);
      if (!gwResp) {
        failures.push(
          `Gateway: falta respuesta HTTP ${status} en ${op.operationId} (${opKey})`,
        );
        continue;
      }
      if (status.startsWith('2')) {
        if (!gwResp.types.includes('application/json')) {
          failures.push(
            `Gateway: respuesta ${status} de ${op.operationId} debe declarar application/json`,
          );
        }
      } else {
        if (!gwResp.types.includes('application/problem+json')) {
          failures.push(
            `Gateway: respuesta ${status} de ${op.operationId} debe declarar application/problem+json`,
          );
        }
        const expectedCodes = op.errorCodes.get(status) ?? [];
        for (const code of expectedCodes) {
          if (!gwResp.codes.includes(code)) {
            failures.push(
              `Gateway: falta código Problem ${code} en HTTP ${status} de ${op.operationId}`,
            );
          }
        }
      }
    }
    for (const gwStatus of gw.responses.keys()) {
      if (!op.responses.has(gwStatus)) {
        failures.push(
          `Gateway: respuesta HTTP ${gwStatus} en ${op.operationId} no declarada en OpenAPI`,
        );
      }
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

// Validación AST estructural de DTOs y respuestas del servicio (sin búsqueda textual global)
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

function getReturnedObjectLiteral(body) {
  if (!body) return undefined;
  for (const stmt of body.statements) {
    if (ts.isReturnStatement(stmt) && stmt.expression) {
      if (ts.isObjectLiteralExpression(stmt.expression)) {
        return stmt.expression;
      }
    }
  }
  return undefined;
}

function getObjectPropMap(obj) {
  const map = new Map();
  for (const prop of obj.properties) {
    if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
      map.set(prop.name.text, prop.initializer);
    } else if (ts.isShorthandPropertyAssignment(prop)) {
      map.set(prop.name.text, prop.name);
    }
  }
  return map;
}

let wireFn;
let listMethod;
let availabilityMethod;
for (const stmt of serviceSource.statements) {
  if (ts.isFunctionDeclaration(stmt) && stmt.name?.text === 'wire') {
    wireFn = stmt;
  } else if (
    ts.isClassDeclaration(stmt) &&
    stmt.name?.text === 'CombosSvcService'
  ) {
    for (const member of stmt.members) {
      if (ts.isMethodDeclaration(member) && ts.isIdentifier(member.name)) {
        if (member.name.text === 'list') listMethod = member;
        if (member.name.text === 'availability') availabilityMethod = member;
      }
    }
  }
}

const wireReturn = getReturnedObjectLiteral(wireFn?.body);
if (!wireReturn) {
  failures.push('DTO Combo (wire): no se encontró objeto de retorno en wire()');
} else {
  const wireProps = getObjectPropMap(wireReturn);
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
    if (!wireProps.has(field)) {
      failures.push(`DTO Combo (wire): falta campo contractual ${field}`);
    }
  }
  const componentsExpr = wireProps.get('components');
  let componentKeys = new Set();
  if (componentsExpr && ts.isCallExpression(componentsExpr)) {
    const cb = componentsExpr.arguments[0];
    if (cb && ts.isArrowFunction(cb)) {
      let itemObj;
      if (ts.isParenthesizedExpression(cb.body)) {
        if (ts.isObjectLiteralExpression(cb.body.expression)) {
          itemObj = cb.body.expression;
        }
      } else if (ts.isObjectLiteralExpression(cb.body)) {
        itemObj = cb.body;
      }
      if (itemObj) {
        componentKeys = new Set(getObjectPropMap(itemObj).keys());
      }
    }
  }
  for (const compField of ['sku', 'quantity']) {
    if (!componentKeys.has(compField)) {
      failures.push(
        `DTO ComponenteCombo (wire): falta campo contractual ${compField}`,
      );
    }
  }
}

const listReturn = getReturnedObjectLiteral(listMethod?.body);
if (!listReturn) {
  failures.push(
    'DTO PaginaCombos (list): no se encontró objeto de retorno en list()',
  );
} else {
  const listProps = getObjectPropMap(listReturn);
  for (const field of ['items', 'meta']) {
    if (!listProps.has(field)) {
      failures.push(`DTO PaginaCombos (list): falta campo contractual ${field}`);
    }
  }
}

const availReturn = getReturnedObjectLiteral(availabilityMethod?.body);
if (!availReturn) {
  failures.push(
    'Disponibilidad conservadora: no se encontró objeto de retorno en availability()',
  );
} else {
  const availProps = getObjectPropMap(availReturn);
  for (const field of [
    'comboId',
    'verificable',
    'cantidadInformativa',
    'calculated_at',
    'estadoActualizacion',
  ]) {
    if (!availProps.has(field)) {
      failures.push(`Disponibilidad conservadora: falta campo ${field}`);
    }
  }
  if (availProps.get('verificable')?.kind !== ts.SyntaxKind.FalseKeyword) {
    failures.push('Disponibilidad conservadora: verificable debe ser false');
  }
  if (
    availProps.get('cantidadInformativa')?.kind !== ts.SyntaxKind.NullKeyword
  ) {
    failures.push(
      'Disponibilidad conservadora: cantidadInformativa debe ser null',
    );
  }
  const estadoInit = availProps.get('estadoActualizacion');
  if (
    !estadoInit ||
    !ts.isStringLiteral(estadoInit) ||
    estadoInit.text !== 'INCOMPLETA'
  ) {
    failures.push(
      "Disponibilidad conservadora: estadoActualizacion debe ser 'INCOMPLETA'",
    );
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
    `PASS (inspección estática, no runtime) ${operations.length}/${operations.length} operaciones Combos (${contractVersion}): rutas, operationId, seguridad, respuestas HTTP, códigos Problem x-error-codes, DTOs AST y disponibilidad conservadora (${contractPath})`,
  );
}
