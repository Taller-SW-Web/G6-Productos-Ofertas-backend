import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { parsers } = require('prettier/plugins/yaml');
const Ajv2020 = require('ajv/dist/2020').default;
const addFormats = require('ajv-formats');

// Convert only the schema nodes consumed below; reject unfamiliar YAML constructs.
function yamlValue(node) {
  switch (node?.type) {
    case 'mapping':
      return Object.fromEntries(
        node.children.map((item) => {
          if (item.type !== 'mappingItem')
            throw new Error('UNSUPPORTED_CONTRACT_YAML');
          const key = item.children.find(
            (child) => child.type === 'mappingKey',
          );
          const value = item.children.find(
            (child) => child.type === 'mappingValue',
          );
          return [
            yamlValue(key.children[0]),
            value?.children?.length ? yamlValue(value.children[0]) : null,
          ];
        }),
      );
    case 'sequence':
      return node.children.map((item) => yamlValue(item.children[0]));
    case 'quoteSingle':
    case 'quoteDouble':
      return node.value;
    case 'plain':
      if (node.value === 'true') return true;
      if (node.value === 'false') return false;
      if (node.value === 'null' || node.value === '~') return null;
      if (/^-?\d+(?:\.\d+)?$/.test(node.value)) return Number(node.value);
      return node.value;
    default:
      throw new Error(`UNSUPPORTED_CONTRACT_YAML_${node?.type}`);
  }
}
function child(node, name) {
  const item = node.children.find(
    (entry) =>
      entry.type === 'mappingItem' &&
      yamlValue(entry.children[0].children[0]) === name,
  );
  if (!item) throw new Error(`CONTRACT_NODE_MISSING_${name}`);
  return item.children.find((entry) => entry.type === 'mappingValue')
    .children[0];
}

export async function loadR18Contract(docsPath) {
  const content = await readFile(
    join(docsPath, 'contratos/eventos/asyncapi.yaml'),
    'utf8',
  );
  const ast = parsers.yaml.parse(content);
  const root = ast.children[0].children.find(
    (entry) => entry.type === 'documentBody',
  ).children[0];
  if (yamlValue(child(child(root, 'info'), 'version')) !== '0.7.0-rc.3')
    throw new Error('UNEXPECTED_ASYNCAPI_VERSION');
  const route = child(child(root, 'channels'), 'g6_catalog_from_taxonomy');
  if (yamlValue(child(route, 'address')) !== 'g6.catalog.from.taxonomy')
    throw new Error('UNEXPECTED_R18_DESTINATION');
  const replyRoute = child(child(root, 'channels'), 'g6_taxonomy_from_catalog');
  if (yamlValue(child(replyRoute, 'address')) !== 'g6.taxonomy.from.catalog')
    throw new Error('UNEXPECTED_R09_DESTINATION');
  const components = child(root, 'components');
  const schemaNode = child(components, 'schemas');
  const messageNode = child(components, 'messages');
  const schemaNames = [
    'MessageEnvelope',
    'GenericData',
    'MasterDeactivationIdentityData',
    'MasterDeactivationAssociationData',
    'MasterDeactivationData',
    'MasterDeactivationCheckedData',
    'MasterDeactivationCompletedData',
    'MasterDeactivationRejectedData',
  ];
  const schemas = Object.fromEntries(
    schemaNames.map((name) => [name, yamlValue(child(schemaNode, name))]),
  );
  const names = [
    'TaxonomyCategoryUpdated',
    'TaxonomyProductTypeSchemaChanged',
    'TaxonomyCharacteristicValueUpdated',
    'TaxonomyMasterDeactivationCheckRequested',
    'TaxonomyMasterDeactivated',
    'TaxonomyMasterDeactivationRejected',
    'CatalogMasterDeactivationChecked',
  ];
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  return new Map(
    names.map((name) => {
      const node = child(messageNode, name);
      const eventName = yamlValue(child(node, 'name'));
      const payload = yamlValue(child(node, 'payload'));
      const validate = ajv.compile({ components: { schemas }, ...payload });
      return [
        eventName,
        (message) => {
          if (!validate(message))
            throw new Error(`${eventName}: ${ajv.errorsText(validate.errors)}`);
        },
      ];
    }),
  );
}
