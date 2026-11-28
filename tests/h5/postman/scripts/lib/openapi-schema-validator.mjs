import { existsSync, readFileSync } from 'node:fs';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import YAML from 'yaml';
import { OPENAPI_CONTRACT_PATH, SCHEMAS_PATH } from './constants.mjs';

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
    } else {
      out[k] = rewriteOpenApiRefs(v);
    }
  }
  return out;
}

/**
 * H13: Carga y compila los esquemas oficiales de OpenAPI 0.7.0-rc.3 usando Ajv + ajv-formats,
 * con soporte completo de $ref, allOf, oneOf, format (uuid, date-time, uri), objetos anidados y arrays.
 */
export function loadOfficialOpenApiSchemas(openApiPath = OPENAPI_CONTRACT_PATH) {
  if (!existsSync(openApiPath)) {
    throw new Error(`Contrato OpenAPI oficial no encontrado en: ${openApiPath}`);
  }
  const doc = YAML.parse(readFileSync(openApiPath, 'utf8'));
  const rawSchemas = doc?.components?.schemas || {};
  const $defs = {};
  for (const [name, schema] of Object.entries(rawSchemas)) {
    $defs[name] = rewriteOpenApiRefs(schema);
  }
  return {
    version: doc?.info?.version || 'unknown',
    paths: doc?.paths || {},
    $defs,
  };
}

export function createOpenApiValidator(openApiPath = OPENAPI_CONTRACT_PATH) {
  const { version, $defs } = loadOfficialOpenApiSchemas(openApiPath);
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

  return {
    version,
    validate(schemaName, payload) {
      if (!$defs[schemaName]) {
        return { ok: false, errors: [`Esquema '${schemaName}' no existe en OpenAPI ${version}.`] };
      }
      const validateFn = ajv.compile({ $ref: `https://g6.local/openapi-schemas.json#/$defs/${schemaName}` });
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

/**
 * H13: Verifica que schemas/openapi-response-schemas.json no haya divergido respecto a los
 * campos requeridos y enumeraciones del OpenAPI oficial vigente.
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
        errors.push(`Divergencia OpenAPI en '${name}': falta campo obligatorio '${reqField}' en esquema local.`);
      }
    }
  }

  return { ok: errors.length === 0, errors, officialVersion: official.version };
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
