import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import YAML from 'yaml';
import {
  OPENAPI_CONTRACT_PATH,
  PM_RESPONSE_SCHEMA_MAP,
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
      // OpenAPI 3.0 nullable -> JSON Schema union type
      out.nullable = true;
    } else {
      out[k] = rewriteOpenApiRefs(v);
    }
  }
  if (out.nullable === true && typeof out.type === 'string') {
    out.type = [out.type, 'null'];
    delete out.nullable;
  }
  return out;
}

/**
 * H17 + H22: Carga los esquemas desde el OpenAPI oficial (fuente unica de verdad)
 * y calcula su checksum SHA-256 para trazabilidad.
 */
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
  return {
    version: doc?.info?.version || 'unknown',
    sha256,
    paths: doc?.paths || {},
    $defs,
  };
}

export function createOpenApiValidator(openApiPath = OPENAPI_CONTRACT_PATH) {
  const { version, sha256, $defs } = loadOfficialOpenApiSchemas(openApiPath);
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

  const compiledCache = new Map();

  return {
    version,
    sha256,
    validate(schemaName, payload) {
      if (!$defs[schemaName]) {
        return { ok: false, errors: [`Esquema '${schemaName}' no existe en OpenAPI ${version}.`] };
      }
      let validateFn = compiledCache.get(schemaName);
      if (!validateFn) {
        validateFn = ajv.compile({ $ref: `https://g6.local/openapi-schemas.json#/$defs/${schemaName}` });
        compiledCache.set(schemaName, validateFn);
      }
      const ok = validateFn(payload);
      return {
        ok: Boolean(ok),
        errors: ok
          ? []
          : (validateFn.errors || []).map((e) => `${e.instancePath || '/'} ${e.message}`),
      };
    },
  };
}

function normalizeTypes(schema) {
  if (!schema || typeof schema !== 'object') return [];
  if (Array.isArray(schema.type)) return [...schema.type].sort();
  if (typeof schema.type === 'string') return [schema.type];
  return [];
}

function resolveRef(schema, defs) {
  if (!schema || typeof schema !== 'object') return schema;
  if (schema.$ref && typeof schema.$ref === 'string') {
    const name = schema.$ref.replace('#/$defs/', '');
    return defs[name] ? resolveRef(defs[name], defs) : schema;
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
 * H17: Comparacion estructural profunda entre schemas locales y OpenAPI oficial:
 * valida version, required, tipos, enumeraciones, formatos, limites numericos,
 * additionalProperties y referencias/estructuras anidadas.
 */
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

    const offReq = collectRequired(offDef, official.$defs);
    const locReq = new Set(locDef.required || []);
    for (const reqField of offReq) {
      if (!locReq.has(reqField)) {
        errors.push(`Divergencia OpenAPI en '${name}': falta campo obligatorio '${reqField}'.`);
      }
    }

    if (offDef.additionalProperties === false && locDef.additionalProperties !== false) {
      errors.push(`Divergencia OpenAPI en '${name}': additionalProperties debe ser false.`);
    }

    const offProps = collectProperties(offDef, official.$defs);
    const locProps = collectProperties(locDef, local.$defs || {});

    for (const [propName, rawOffProp] of Object.entries(offProps)) {
      const rawLocProp = locProps[propName];
      if (!rawLocProp) continue;
      const offProp = resolveRef(rawOffProp, official.$defs);
      const locProp = resolveRef(rawLocProp, local.$defs || {});

      const offTypes = normalizeTypes(offProp);
      const locTypes = normalizeTypes(locProp);
      if (offTypes.length > 0 && locTypes.length > 0) {
        const offBase = offTypes.filter((t) => t !== 'null');
        const locBase = locTypes.filter((t) => t !== 'null');
        if (JSON.stringify(offBase) !== JSON.stringify(locBase)) {
          errors.push(
            `Divergencia de tipo en '${name}.${propName}': oficial=${JSON.stringify(offTypes)} vs local=${JSON.stringify(locTypes)}.`,
          );
        }
      }

      if (Array.isArray(offProp.enum)) {
        const locEnum = Array.isArray(locProp.enum) ? locProp.enum.filter((v) => v !== null) : null;
        if (!locEnum || offProp.enum.some((v) => !locEnum.includes(v))) {
          errors.push(
            `Divergencia de enum en '${name}.${propName}': oficial=${JSON.stringify(offProp.enum)} vs local=${JSON.stringify(locProp.enum)}.`,
          );
        }
      }

      if (offProp.format && ['date-time', 'uuid', 'uri'].includes(offProp.format) && locProp.format !== offProp.format) {
        errors.push(
          `Divergencia de formato en '${name}.${propName}': oficial='${offProp.format}' vs local='${locProp.format || 'none'}'.`,
        );
      }

      if (offProp.minimum !== undefined && locProp.minimum !== offProp.minimum) {
        errors.push(
          `Divergencia de minimum en '${name}.${propName}': oficial=${offProp.minimum} vs local=${locProp.minimum}.`,
        );
      }

      if (offProp.exclusiveMinimum !== undefined && locProp.exclusiveMinimum !== offProp.exclusiveMinimum) {
        errors.push(
          `Divergencia de exclusiveMinimum en '${name}.${propName}': oficial=${offProp.exclusiveMinimum} vs local=${locProp.exclusiveMinimum}.`,
        );
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    officialVersion: official.version,
    officialSha256: official.sha256,
  };
}

/**
 * H17: Valida respuestas HTTP (principales y auxiliares) directamente contra OpenAPI oficial compilado en Ajv.
 */
export function inferSchemaForUrlAndStatus(pmId, url, statusCode) {
  if (pmId && PM_RESPONSE_SCHEMA_MAP[pmId]?.[statusCode]) {
    return PM_RESPONSE_SCHEMA_MAP[pmId][statusCode];
  }
  const path = String(url || '').split('?')[0];
  if (statusCode === 200) {
    if (path.endsWith('/api/v1/productos')) return 'PaginaProductosComercial';
    if (/\/api\/v1\/productos\/[^/]+$/.test(path)) return 'ProductoDetalleComercial';
    if (path.endsWith('/api/v1/precios')) return 'ConsultaPrecios';
    if (path.endsWith('/api/v1/inventario/disponibilidad/comercial')) return 'ConsultaDisponibilidadComercialResponse';
    if (path.endsWith('/api/v1/inventario/disponibilidad')) return 'ConsultaDisponibilidadResponse';
  }
  return null;
}

export function validateNewmanExecutionsWithAjv(rawSummary, openApiPath = OPENAPI_CONTRACT_PATH) {
  const validator = createOpenApiValidator(openApiPath);
  const violations = [];
  const executions = Array.isArray(rawSummary?.run?.executions) ? rawSummary.run.executions : [];

  for (const exec of executions) {
    if (!exec.response || !exec.response.stream) continue;
    const statusCode = exec.response.code;
    const contentType = (exec.response.header || [])
      .find((h) => String(h.key || '').toLowerCase() === 'content-type')
      ?.value || '';
    if (!String(contentType).toLowerCase().includes('json')) continue;

    const itemName = String(exec.item?.name || '');
    const pmId = itemName.match(/^(PM-\d+[A-Z]?)\b/)?.[1] || null;
    const rawUrl = typeof exec.request?.url === 'string'
      ? exec.request.url
      : exec.request?.url?.path
        ? `/${exec.request.url.path.join('/')}`
        : '';

    const schemaName = inferSchemaForUrlAndStatus(pmId, rawUrl, statusCode);
    if (!schemaName) continue;

    let payload;
    try {
      const text = Buffer.isBuffer(exec.response.stream)
        ? exec.response.stream.toString('utf8')
        : Buffer.from(exec.response.stream?.data || exec.response.stream).toString('utf8');
      payload = JSON.parse(text);
    } catch {
      violations.push({ pmId: pmId || 'AUX', schemaName, errors: ['Respuesta JSON no parseable'] });
      continue;
    }

    const check = validator.validate(schemaName, payload);
    if (!check.ok) {
      violations.push({
        pmId: pmId || 'AUX',
        schemaName,
        url: rawUrl,
        statusCode,
        errors: check.errors,
      });
    }
  }

  return {
    ok: violations.length === 0,
    openApiVersion: validator.version,
    openApiSha256: validator.sha256,
    violations,
  };
}
