import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import YAML from 'yaml';
import {
  OPENAPI_CONTRACT_PATH,
  SCHEMAS_PATH,
} from './constants.mjs';

export const CORE_CONTRACT_SCHEMAS = Object.freeze([
  'PaginaProductosComercial',
  'ProductoResumenComercial',
  'ProductoDetalleComercial',
  'VarianteComercial',
  'Precio',
  'ConsultaPrecios',
  'DisponibilidadStock',
  'ConsultaDisponibilidadResponse',
  'DisponibilidadComercial',
  'ConsultaDisponibilidadComercialResponse',
  'Problem',
]);

// H24: Unicas rutas explicitamente exentas del contrato OpenAPI /api/v1 (justificadas por diseno)
export const EXPLICIT_NON_OPENAPI_PATHS = Object.freeze(
  new Set([
    '/health',
    '/health/ready',
    '/api/v1/ruta-inexistente-h5-probe',
  ]),
);

function rewriteOpenApiRefs(node) {
  if (Array.isArray(node)) return node.map(rewriteOpenApiRefs);
  if (!node || typeof node !== 'object') return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === '$ref' && typeof v === 'string' && v.startsWith('#/components/schemas/')) {
      out[k] = v.replace('#/components/schemas/', '#/$defs/');
    } else if (k.startsWith('x-')) {
      continue;
    } else if (k === 'nullable' && v === true) {
      out.nullable = true;
    } else {
      out[k] = rewriteOpenApiRefs(v);
    }
  }
  if (out.nullable === true) {
    if (typeof out.type === 'string') {
      out.type = [out.type, 'null'];
    } else if (out.$ref) {
      const refTarget = out.$ref;
      delete out.$ref;
      out.anyOf = [{ $ref: refTarget }, { type: 'null' }];
    }
    delete out.nullable;
  }
  return out;
}

export function loadOfficialOpenApiSchemas(openApiPath = OPENAPI_CONTRACT_PATH) {
  if (!existsSync(openApiPath)) {
    throw new Error(
      `Contrato OpenAPI oficial no encontrado en: ${openApiPath}. Configure G6_DOCS_ROOT hacia el checkout de G6-Productos-Ofertas-docs.`,
    );
  }
  const rawBuffer = readFileSync(openApiPath);
  const sha256 = createHash('sha256').update(rawBuffer).digest('hex');
  const doc = YAML.parse(rawBuffer.toString('utf8'));
  const rawSchemas = doc?.components?.schemas || {};
  const $defs = {};
  for (const [name, schema] of Object.entries(rawSchemas)) {
    $defs[name] = rewriteOpenApiRefs(schema);
  }
  const rawResponses = doc?.components?.responses || {};
  const responses = {};
  for (const [name, resp] of Object.entries(rawResponses)) {
    responses[name] = rewriteOpenApiRefs(resp);
  }
  return {
    version: doc?.info?.version || 'unknown',
    sha256,
    paths: doc?.paths || {},
    responses,
    $defs,
  };
}

function normalizePath(rawUrl) {
  let pathPart = String(rawUrl || '').split('?')[0].split('#')[0];
  pathPart = pathPart.replace(/^https?:\/\/[^/]+/i, '');
  if (!pathPart.startsWith('/')) pathPart = `/${pathPart}`;
  return pathPart;
}

function stripApiPrefix(pathPart) {
  return pathPart.startsWith('/api/v1/')
    ? pathPart.slice('/api/v1'.length)
    : pathPart === '/api/v1'
      ? '/'
      : pathPart;
}

/**
 * H24: Resuelve la operacion OpenAPI oficial a partir de (metodo HTTP, ruta efectiva, statusCode, Content-Type).
 * Prioriza siempre la ruta y operacion reales por encima del identificador PM del caso padre.
 */
export function resolveOpenApiResponseSpec(openApiDoc, method, rawUrl, statusCode, rawContentType = '') {
  const fullPath = normalizePath(rawUrl);
  if (EXPLICIT_NON_OPENAPI_PATHS.has(fullPath)) {
    return { status: 'EXEMPT', reason: `Ruta fuera de contrato OpenAPI justificada (${fullPath}).` };
  }

  const openApiPath = stripApiPrefix(fullPath);
  const reqSegs = openApiPath.split('/').filter(Boolean);
  const lowerMethod = String(method || 'GET').toLowerCase();

  let matchedOp = null;
  let matchedTemplate = null;

  // Preferir coincidencia exacta de segmentos literales antes que parametros {id}
  let bestLiteralScore = -1;
  for (const [template, pathItem] of Object.entries(openApiDoc.paths || {})) {
    const op = pathItem?.[lowerMethod];
    if (!op) continue;
    const tplSegs = template.split('/').filter(Boolean);
    if (tplSegs.length !== reqSegs.length) continue;
    let literalScore = 0;
    let ok = true;
    for (let i = 0; i < tplSegs.length; i += 1) {
      const isParam = tplSegs[i].startsWith('{') && tplSegs[i].endsWith('}');
      if (isParam) continue;
      if (tplSegs[i] !== reqSegs[i]) {
        ok = false;
        break;
      }
      literalScore += 1;
    }
    if (ok && literalScore > bestLiteralScore) {
      bestLiteralScore = literalScore;
      matchedOp = op;
      matchedTemplate = template;
    }
  }

  if (!matchedOp) {
    return {
      status: 'UNRESOLVED',
      reason: `No existe operacion OpenAPI oficial para ${String(method).toUpperCase()} ${openApiPath}.`,
    };
  }

  const statusKey = String(statusCode);
  let respSpec = matchedOp.responses?.[statusKey] || matchedOp.responses?.default;
  if (!respSpec) {
    return {
      status: 'UNRESOLVED',
      operationId: matchedOp.operationId || `${lowerMethod} ${matchedTemplate}`,
      reason: `Codigo HTTP ${statusCode} no documentado en OpenAPI para ${matchedOp.operationId || matchedTemplate}.`,
    };
  }

  if (respSpec.$ref && typeof respSpec.$ref === 'string' && respSpec.$ref.startsWith('#/components/responses/')) {
    const refName = respSpec.$ref.replace('#/components/responses/', '');
    respSpec = openApiDoc.responses?.[refName] || respSpec;
  }

  const contentMap = respSpec.content || {};
  const allowedMediaTypes = Object.keys(contentMap);
  if (allowedMediaTypes.length === 0) {
    return {
      status: 'VALID_NO_BODY',
      operationId: matchedOp.operationId || `${lowerMethod} ${matchedTemplate}`,
      template: matchedTemplate,
    };
  }

  const actualMedia = String(rawContentType || '').split(';')[0].trim().toLowerCase();
  const matchedMedia = allowedMediaTypes.find((mt) => mt.toLowerCase() === actualMedia);
  if (!matchedMedia) {
    return {
      status: 'CONTENT_TYPE_MISMATCH',
      operationId: matchedOp.operationId || `${lowerMethod} ${matchedTemplate}`,
      template: matchedTemplate,
      expectedMediaTypes: allowedMediaTypes,
      actualMediaType: actualMedia || '(vacio)',
      reason: `Content-Type '${actualMedia || '(vacio)'}' no coincide con los permitidos por OpenAPI [${allowedMediaTypes.join(', ')}] en ${matchedOp.operationId || matchedTemplate} (${statusCode}).`,
    };
  }

  const isJson = matchedMedia.includes('json');
  const rawSchema = contentMap[matchedMedia]?.schema || null;
  return {
    status: 'RESOLVED',
    operationId: matchedOp.operationId || `${lowerMethod} ${matchedTemplate}`,
    template: matchedTemplate,
    mediaType: matchedMedia,
    isJson,
    schema: rawSchema ? rewriteOpenApiRefs(rawSchema) : null,
  };
}

const VALIDATOR_CACHE_BY_SHA = new Map();

export function createOpenApiValidator(openApiPath = OPENAPI_CONTRACT_PATH) {
  const openApiDoc = loadOfficialOpenApiSchemas(openApiPath);
  const { version, sha256, $defs } = openApiDoc;
  const cacheKeyRoot = `${resolve(openApiPath)}::${sha256}`;
  if (VALIDATOR_CACHE_BY_SHA.has(cacheKeyRoot)) {
    return VALIDATOR_CACHE_BY_SHA.get(cacheKeyRoot);
  }
  const ajv = new Ajv({
    allErrors: true,
    strict: false,
    allowUnionTypes: true,
  });
  addFormats(ajv);

  const rootSchema = {
    $id: 'https://g6.local/openapi-schemas.json',
    $defs,
  };
  ajv.addSchema(rootSchema);

  const compiledByName = new Map();
  const compiledBySchemaKey = new Map();
  let precompiled = false;

  const validator = {
    version,
    sha256,
    openApiDoc,
    validate(schemaName, payload) {
      if (!$defs[schemaName]) {
        return { ok: false, errors: [`Esquema '${schemaName}' no existe en OpenAPI ${version}.`] };
      }
      let validateFn = compiledByName.get(schemaName);
      if (!validateFn) {
        validateFn = ajv.compile({ $ref: `https://g6.local/openapi-schemas.json#/$defs/${schemaName}` });
        compiledByName.set(schemaName, validateFn);
      }
      const ok = validateFn(payload);
      return {
        ok: Boolean(ok),
        errors: ok
          ? []
          : (validateFn.errors || []).map((e) => `${e.instancePath || '/'} ${e.message}`),
      };
    },
    validateInlineSchema(schemaObj, payload, cacheKey) {
      if (!schemaObj) return { ok: true, errors: [] };
      const key = cacheKey || JSON.stringify(schemaObj);
      let validateFn = compiledBySchemaKey.get(key);
      if (!validateFn) {
        const wrapped = {
          ...schemaObj,
          $defs,
        };
        validateFn = ajv.compile(wrapped);
        compiledBySchemaKey.set(key, validateFn);
      }
      const ok = validateFn(payload);
      return {
        ok: Boolean(ok),
        errors: ok
          ? []
          : (validateFn.errors || []).map((e) => `${e.instancePath || '/'} ${e.message}`),
      };
    },
    precompileResponseSchemas() {
      if (precompiled) return { compiledCount: compiledBySchemaKey.size };
      // H32: Compilacion previa obligatoria de todos los esquemas de respuesta JSON antes de enviar solicitudes HTTP
      let compiledCount = 0;
      const httpMethods = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);
      for (const [pathTemplate, pathItem] of Object.entries(openApiDoc.paths || {})) {
        if (!pathItem || typeof pathItem !== 'object') continue;
        for (const [method, op] of Object.entries(pathItem)) {
          if (!httpMethods.has(method.toLowerCase()) || !op || typeof op !== 'object') continue;
          for (const [statusKey, rawResp] of Object.entries(op.responses || {})) {
            let respSpec = rawResp;
            if (respSpec?.$ref && typeof respSpec.$ref === 'string' && respSpec.$ref.startsWith('#/components/responses/')) {
              const refName = respSpec.$ref.replace('#/components/responses/', '');
              respSpec = openApiDoc.responses?.[refName] || respSpec;
            }
            const contentMap = respSpec?.content || {};
            for (const [mediaType, mediaObj] of Object.entries(contentMap)) {
              if (!mediaType.toLowerCase().includes('json') || !mediaObj?.schema) continue;
              const rewritten = rewriteOpenApiRefs(mediaObj.schema);
              const cacheKey = `${method.toUpperCase()} ${pathTemplate} ${statusKey} ${mediaType}`;
              if (!compiledBySchemaKey.has(cacheKey)) {
                const validateFn = ajv.compile({ ...rewritten, $defs });
                compiledBySchemaKey.set(cacheKey, validateFn);
              }
              compiledCount += 1;
            }
          }
        }
      }
      precompiled = true;
      return { compiledCount };
    },
  };
  VALIDATOR_CACHE_BY_SHA.set(cacheKeyRoot, validator);
  return validator;
}

function normalizeTypes(schema) {
  if (!schema || typeof schema !== 'object') return [];
  if (Array.isArray(schema.type)) return [...schema.type].sort();
  if (typeof schema.type === 'string') return [schema.type];
  return [];
}

function resolveRef(schema, defs, seen = new Set()) {
  if (!schema || typeof schema !== 'object') return schema;
  if (schema.$ref && typeof schema.$ref === 'string') {
    const name = schema.$ref.replace('#/$defs/', '');
    if (!seen.has(name) && defs[name]) {
      seen.add(name);
      return resolveRef(defs[name], defs, seen);
    }
  }
  return schema;
}

function collectRequired(schema, defs, seen = new Set()) {
  const req = new Set();
  if (!schema || typeof schema !== 'object') return req;
  if (schema.$ref && typeof schema.$ref === 'string') {
    const refName = schema.$ref.replace('#/$defs/', '');
    if (!seen.has(refName) && defs[refName]) {
      seen.add(refName);
      for (const r of collectRequired(defs[refName], defs, seen)) req.add(r);
    }
  }
  for (const r of schema.required || []) req.add(r);
  for (const sub of schema.allOf || []) {
    for (const r of collectRequired(sub, defs, seen)) req.add(r);
  }
  return req;
}

function collectProperties(schema, defs, seen = new Set()) {
  const props = {};
  if (!schema || typeof schema !== 'object') return props;
  if (schema.$ref && typeof schema.$ref === 'string') {
    const refName = schema.$ref.replace('#/$defs/', '');
    if (!seen.has(refName) && defs[refName]) {
      seen.add(refName);
      Object.assign(props, collectProperties(defs[refName], defs, seen));
    }
  }
  if (schema.properties) Object.assign(props, schema.properties);
  for (const sub of schema.allOf || []) {
    Object.assign(props, collectProperties(sub, defs, seen));
  }
  return props;
}

/**
 * H24: Comparacion estructural recursiva completa (required, type, enum, const, pattern,
 * format, minimum, maximum, exclusiveMinimum, additionalProperties, items y propiedades anidadas).
 */
function compareSchemasRecursive(label, rawOff, rawLoc, offDefs, locDefs, errors, depth = 0) {
  if (depth > 8 || !rawOff || !rawLoc) return;
  const off = resolveRef(rawOff, offDefs);
  const loc = resolveRef(rawLoc, locDefs);

  const offTypes = normalizeTypes(off);
  const locTypes = normalizeTypes(loc);
  if (offTypes.length > 0 && locTypes.length > 0) {
    const offBase = offTypes.filter((t) => t !== 'null');
    const locBase = locTypes.filter((t) => t !== 'null');
    if (JSON.stringify(offBase) !== JSON.stringify(locBase)) {
      errors.push(`Divergencia de tipo en '${label}': oficial=${JSON.stringify(offTypes)} vs local=${JSON.stringify(locTypes)}.`);
    }
  }

  if (Array.isArray(off.enum)) {
    const locEnum = Array.isArray(loc.enum) ? loc.enum.filter((v) => v !== null) : null;
    if (!locEnum || off.enum.some((v) => !locEnum.includes(v))) {
      errors.push(`Divergencia de enum en '${label}': oficial=${JSON.stringify(off.enum)} vs local=${JSON.stringify(loc.enum)}.`);
    }
  }

  if (off.const !== undefined && loc.const !== off.const) {
    errors.push(`Divergencia de const en '${label}': oficial=${JSON.stringify(off.const)} vs local=${JSON.stringify(loc.const)}.`);
  }

  if (off.pattern !== undefined && loc.pattern !== off.pattern) {
    errors.push(`Divergencia de pattern en '${label}': oficial='${off.pattern}' vs local='${loc.pattern || 'none'}'.`);
  }

  if (off.format && ['date-time', 'uuid', 'uri'].includes(off.format) && loc.format !== off.format) {
    errors.push(`Divergencia de formato en '${label}': oficial='${off.format}' vs local='${loc.format || 'none'}'.`);
  }

  if (off.minimum !== undefined && loc.minimum !== off.minimum) {
    errors.push(`Divergencia de minimum en '${label}': oficial=${off.minimum} vs local=${loc.minimum}.`);
  }

  if (off.maximum !== undefined && loc.maximum !== off.maximum) {
    errors.push(`Divergencia de maximum en '${label}': oficial=${off.maximum} vs local=${loc.maximum}.`);
  }

  if (off.exclusiveMinimum !== undefined && loc.exclusiveMinimum !== off.exclusiveMinimum) {
    errors.push(`Divergencia de exclusiveMinimum en '${label}': oficial=${off.exclusiveMinimum} vs local=${loc.exclusiveMinimum}.`);
  }

  if (off.additionalProperties === false && loc.additionalProperties !== false) {
    errors.push(`Divergencia OpenAPI en '${label}': additionalProperties debe ser false.`);
  }

  const offReq = collectRequired(off, offDefs);
  const locReq = collectRequired(loc, locDefs);
  for (const reqField of offReq) {
    if (!locReq.has(reqField)) {
      errors.push(`Divergencia OpenAPI en '${label}': falta campo obligatorio '${reqField}'.`);
    }
  }

  if (off.items && loc.items) {
    compareSchemasRecursive(`${label}[]`, off.items, loc.items, offDefs, locDefs, errors, depth + 1);
  }

  const offProps = collectProperties(off, offDefs);
  const locProps = collectProperties(loc, locDefs);
  for (const [propName, offChild] of Object.entries(offProps)) {
    if (locProps[propName]) {
      compareSchemasRecursive(`${label}.${propName}`, offChild, locProps[propName], offDefs, locDefs, errors, depth + 1);
    }
  }
}

export function verifySchemaContractAlignment(
  openApiPath = OPENAPI_CONTRACT_PATH,
  localSchemasPath = SCHEMAS_PATH,
) {
  const errors = [];
  if (!existsSync(localSchemasPath)) {
    return { ok: false, errors: [`Falta archivo de esquemas locales: ${localSchemasPath}`] };
  }
  const official = loadOfficialOpenApiSchemas(openApiPath);
  const local = JSON.parse(readFileSync(localSchemasPath, 'utf8'));

  if (local.sourceVersion !== official.version) {
    errors.push(
      `Version de OpenAPI divergente: local='${local.sourceVersion}' vs oficial='${official.version}'.`,
    );
  }

  for (const name of CORE_CONTRACT_SCHEMAS) {
    const offDef = official.$defs[name];
    const locDef = local.$defs?.[name];
    if (!offDef) {
      errors.push(`Esquema '${name}' no encontrado en OpenAPI oficial.`);
      continue;
    }
    if (!locDef) {
      errors.push(`Esquema '${name}' faltante en ${localSchemasPath}.`);
      continue;
    }
    compareSchemasRecursive(name, offDef, locDef, official.$defs, local.$defs || {}, errors, 0);
  }

  return {
    ok: errors.length === 0,
    errors,
    officialVersion: official.version,
    officialSha256: official.sha256,
  };
}

/**
 * H24: Valida TODAS las respuestas HTTP ejecutadas (principales y auxiliares) resolviendo
 * el esquema directamente desde (metodo HTTP, ruta efectiva, codigo de estado, Content-Type)
 * en el OpenAPI oficial compilado con Ajv. Nunca omite silenciosamente respuestas JSON.
 */
export function validateNewmanExecutionsWithAjv(rawSummary, openApiPath = OPENAPI_CONTRACT_PATH) {
  const validator = createOpenApiValidator(openApiPath);
  const violations = [];
  const auditLog = [];
  const executions = Array.isArray(rawSummary?.run?.executions) ? rawSummary.run.executions : [];
  const seenPrimaryPmIds = new Set();

  for (const exec of executions) {
    if (!exec.response) continue;
    const statusCode = exec.response.code;
    const method = String(exec.request?.method || 'GET').toUpperCase();
    const contentType = (exec.response.header || [])
      .find((h) => String(h.key || '').toLowerCase() === 'content-type')
      ?.value || '';

    const itemName = String(exec.item?.name || '');
    const rawPmId = itemName.match(/^(PM-\d+[A-Z]?)\b/)?.[1] || null;
    const rawUrl = typeof exec.request?.url === 'string'
      ? exec.request.url
      : exec.request?.url?.path
        ? `/${exec.request.url.path.join('/')}`
        : '';
    const itemReqUrl = typeof exec.item?.request?.url === 'string'
      ? exec.item.request.url
      : exec.item?.request?.url?.path
        ? `/${exec.item.request.url.path.join('/')}`
        : '';
    // H31: En Newman, pm.sendRequest genera ejecuciones auxiliares sin aserciones propias o cuya ruta
    // difiere de la ruta declarada del item PM; clasificarlas como AUX para no inflar casos PM fallidos.
    const isRealNewmanRun = Boolean(exec.cursor);
    const hasPrimaryAssertions = Array.isArray(exec.assertions) && exec.assertions.length > 0;
    const itemPathDiffers = Boolean(
      itemReqUrl && rawUrl && normalizePath(itemReqUrl) !== normalizePath(rawUrl),
    );
    const pmId = isRealNewmanRun
      ? rawPmId && hasPrimaryAssertions && !itemPathDiffers && !seenPrimaryPmIds.has(rawPmId)
        ? rawPmId
        : null
      : rawPmId;
    if (pmId) seenPrimaryPmIds.add(pmId);

    const resolved = resolveOpenApiResponseSpec(
      validator.openApiDoc,
      method,
      rawUrl,
      statusCode,
      contentType,
    );

    if (resolved.status === 'EXEMPT' || resolved.status === 'VALID_NO_BODY') {
      auditLog.push({ pmId: pmId || 'AUX', method, url: normalizePath(rawUrl), statusCode, outcome: resolved.status });
      continue;
    }

    if (resolved.status === 'UNRESOLVED' || resolved.status === 'CONTENT_TYPE_MISMATCH') {
      violations.push({
        pmId: pmId || 'AUX',
        operationId: resolved.operationId || `${method} ${normalizePath(rawUrl)}`,
        url: normalizePath(rawUrl),
        statusCode,
        errors: [resolved.reason],
      });
      continue;
    }

    if (!resolved.isJson || !resolved.schema) {
      auditLog.push({ pmId: pmId || 'AUX', method, url: normalizePath(rawUrl), statusCode, outcome: 'VALID_NON_JSON' });
      continue;
    }

    if (!exec.response.stream) {
      violations.push({
        pmId: pmId || 'AUX',
        operationId: resolved.operationId,
        url: normalizePath(rawUrl),
        statusCode,
        errors: ['Cuerpo de respuesta JSON vacio o ausente'],
      });
      continue;
    }

    let payload;
    try {
      const text = Buffer.isBuffer(exec.response.stream)
        ? exec.response.stream.toString('utf8')
        : Buffer.from(exec.response.stream?.data || exec.response.stream).toString('utf8');
      payload = JSON.parse(text);
    } catch {
      violations.push({
        pmId: pmId || 'AUX',
        operationId: resolved.operationId,
        url: normalizePath(rawUrl),
        statusCode,
        errors: ['Respuesta JSON no parseable'],
      });
      continue;
    }

    const cacheKey = `${resolved.operationId}:${statusCode}:${resolved.mediaType}`;
    const check = validator.validateInlineSchema(resolved.schema, payload, cacheKey);
    if (!check.ok) {
      violations.push({
        pmId: pmId || 'AUX',
        operationId: resolved.operationId,
        url: normalizePath(rawUrl),
        statusCode,
        errors: check.errors,
      });
    } else {
      auditLog.push({
        pmId: pmId || 'AUX',
        operationId: resolved.operationId,
        method,
        url: normalizePath(rawUrl),
        statusCode,
        outcome: 'VALIDATED',
      });
    }
  }

  return {
    ok: violations.length === 0,
    openApiVersion: validator.version,
    openApiSha256: validator.sha256,
    violations,
    auditLog,
  };
}
