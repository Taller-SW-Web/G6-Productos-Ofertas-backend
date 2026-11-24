import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';

export const FIXTURE_SEED = 20261123;
export const FIXTURE_DIRECTORY = dirname(fileURLToPath(import.meta.url));
export const MANIFEST_PATH = join(FIXTURE_DIRECTORY, 'manifest.json');
export const CHECKSUM_PATH = join(FIXTURE_DIRECTORY, 'manifest.sha256');

const definitions = [
  {
    suffix: 'simple',
    state: 'ACTIVO',
    sku: 'POMA-H5-SIMPLE-0001',
    eligible: true,
    price: 12990,
    stock: 8,
  },
  {
    suffix: 'variable',
    state: 'ACTIVO',
    sku: 'POMA-H5-VARIABLE-0002',
    eligible: true,
    variants: [
      {
        suffix: 'red-s',
        sku: 'POMA-H5-VAR-RED-S-0002',
        state: 'ACTIVA',
        eligible: true,
        price: 18990,
        stock: 5,
      },
      {
        suffix: 'blue-m',
        sku: 'POMA-H5-VAR-BLUE-M-0002',
        state: 'ACTIVA',
        eligible: true,
        price: 19990,
        priceScope: 'GLOBAL',
        stock: 2,
      },
    ],
  },
  {
    suffix: 'inactive',
    state: 'INACTIVO',
    sku: 'POMA-H5-INACTIVE-0003',
    eligible: false,
    price: 10990,
    stock: 4,
  },
  {
    suffix: 'variant-disabled',
    state: 'ACTIVO',
    sku: 'POMA-H5-VARIANT-0004',
    eligible: true,
    variants: [
      {
        suffix: 'enabled',
        sku: 'POMA-H5-VAR-ENABLED-0004',
        state: 'ACTIVA',
        eligible: true,
        price: 15990,
        stock: 4,
      },
      {
        suffix: 'disabled',
        sku: 'POMA-H5-VAR-DISABLED-0004',
        state: 'INACTIVA',
        eligible: false,
        price: 16990,
        stock: 3,
      },
    ],
  },
  {
    suffix: 'no-price',
    state: 'ACTIVO',
    sku: 'POMA-H5-NO-PRICE-0005',
    eligible: true,
    stock: 3,
  },
  {
    suffix: 'no-observed-stock',
    state: 'ACTIVO',
    sku: 'POMA-H5-NO-STOCK-0006',
    eligible: true,
    price: 17990,
  },
  {
    suffix: 'not-sellable',
    state: 'ACTIVO',
    sku: 'POMA-H5-NOT-SELLABLE-0007',
    eligible: false,
    price: 11990,
    stock: 6,
  },
  ...Array.from({ length: 18 }, (_, index) => ({
    suffix: `page-${String(index + 8).padStart(3, '0')}`,
    state: 'ACTIVO',
    sku: `POMA-H5-PAGE-${String(index + 8).padStart(4, '0')}`,
    eligible: true,
    price: 10000 + index * 100,
    stock: 1 + (index % 9),
  })),
];

function idFor(label, seed = FIXTURE_SEED) {
  const bytes = createHash('sha256')
    .update(`${seed}:${label}`, 'utf8')
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function buildManifest(seed = FIXTURE_SEED) {
  if (!Number.isSafeInteger(seed) || seed < 1)
    throw new TypeError('La semilla debe ser un entero positivo.');
  const products = definitions.map((definition) => {
    const productId = idFor(`product:${definition.suffix}`, seed);
    const variants = (definition.variants ?? []).map((variant) => ({
      variant_id: idFor(`variant:${definition.suffix}:${variant.suffix}`, seed),
      sku: variant.sku,
      state: variant.state,
      eligible: variant.eligible,
    }));
    return {
      product_id: productId,
      sku_base: definition.sku,
      state: definition.state,
      eligible: definition.eligible,
      variants,
    };
  });
  const pricing = [];
  const inventory = [];
  for (const definition of definitions) {
    const product = products.find(
      (candidate) => candidate.sku_base === definition.sku,
    );
    const priceEntries = definition.variants ?? [definition];
    for (const entry of priceEntries) {
      const sku = entry.sku;
      const variantId =
        product.variants.find((variant) => variant.sku === sku)?.variant_id ??
        null;
      if (entry.price !== undefined)
        pricing.push({
          sku,
          product_id: product.product_id,
          variant_id: variantId,
          channel_id: entry.priceScope === 'GLOBAL' ? null : 'MARKETPLACE',
          amount_minor: entry.price,
          currency: 'PEN',
        });
      if (entry.stock !== undefined) {
        inventory.push({
          sku,
          product_id: product.product_id,
          variant_id: variantId,
          location_id: 'POMA-H5-LOCATION-01',
          observed_on_hand: entry.stock,
        });
      }
    }
  }
  const sellableSkus = products
    .flatMap((product) =>
      product.variants.length > 0
        ? product.variants
            .filter((variant) => product.eligible && variant.eligible)
            .map((variant) => ({
              sku: variant.sku,
              product_id: product.product_id,
              variant_id: variant.variant_id,
            }))
        : product.eligible && product.state === 'ACTIVO'
          ? [
              {
                sku: product.sku_base,
                product_id: product.product_id,
                variant_id: null,
              },
            ]
          : [],
    )
    .sort((left, right) => left.sku.localeCompare(right.sku, 'en'));
  return {
    schema_version: 1,
    dataset_id: `poma-catalog-h5-${seed}`,
    seed,
    pagination: { page_size: 10, stable_sort: 'product_id:asc' },
    products: products.sort((left, right) =>
      left.product_id.localeCompare(right.product_id, 'en'),
    ),
    pricing,
    inventory,
    expected: {
      product_ids: products.map((product) => product.product_id).sort(),
      sku_bases: products.map((product) => product.sku_base).sort(),
      sellable_skus: sellableSkus,
      excluded_product_ids: products
        .filter((product) => !product.eligible || product.state !== 'ACTIVO')
        .map((product) => product.product_id)
        .sort(),
    },
  };
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys(value[key])]),
    );
  }
  return value;
}

export function canonicalJsonBytes(value) {
  return Buffer.from(`${JSON.stringify(sortKeys(value), null, 2)}\n`, 'utf8');
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function verifyManifestBytes(bytes, checksumText) {
  if (!Buffer.isBuffer(bytes))
    throw new TypeError('El manifest debe validarse desde sus bytes reales.');
  if (
    bytes.length >= 3 &&
    bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))
  )
    throw new Error('MANIFEST_BOM');
  if (bytes.includes(0x0d)) throw new Error('MANIFEST_CRLF');
  const actual = sha256(bytes);
  const expected = /^([a-f0-9]{64})  manifest\.json\n$/.exec(checksumText)?.[1];
  if (!expected || expected !== actual)
    throw new Error('MANIFEST_CHECKSUM_MISMATCH');
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('MANIFEST_INVALID_JSON');
  }
  if (!canonicalJsonBytes(parsed).equals(bytes))
    throw new Error('MANIFEST_NOT_CANONICAL');
  validateManifest(parsed);
  return parsed;
}

export function validateManifest(manifest) {
  if (
    !manifest ||
    manifest.schema_version !== 1 ||
    manifest.seed !== FIXTURE_SEED ||
    !Array.isArray(manifest.products)
  )
    throw new Error('MANIFEST_SCHEMA_INVALID');
  const productIds = manifest.products.map((product) => product.product_id);
  const skuBases = manifest.products.map((product) => product.sku_base);
  if (new Set(productIds).size !== productIds.length)
    throw new Error('MANIFEST_DUPLICATE_PRODUCT_ID');
  if (new Set(skuBases).size !== skuBases.length)
    throw new Error('MANIFEST_DUPLICATE_SKU_BASE');
  const allSkus = manifest.products.flatMap((product) => [
    product.sku_base,
    ...product.variants.map((variant) => variant.sku),
  ]);
  if (new Set(allSkus).size !== allSkus.length)
    throw new Error('MANIFEST_DUPLICATE_SKU');
  const computedIds = [...productIds].sort();
  const computedBases = [...skuBases].sort();
  const computedSellable = manifest.products
    .flatMap((product) =>
      product.variants.length > 0
        ? product.variants
            .filter(
              (variant) =>
                product.eligible &&
                product.state === 'ACTIVO' &&
                variant.eligible &&
                variant.state === 'ACTIVA',
            )
            .map((variant) => ({
              sku: variant.sku,
              product_id: product.product_id,
              variant_id: variant.variant_id,
            }))
        : product.eligible && product.state === 'ACTIVO'
          ? [
              {
                sku: product.sku_base,
                product_id: product.product_id,
                variant_id: null,
              },
            ]
          : [],
    )
    .sort((left, right) => left.sku.localeCompare(right.sku, 'en'));
  if (
    JSON.stringify(manifest.expected.product_ids) !==
      JSON.stringify(computedIds) ||
    JSON.stringify(manifest.expected.sku_bases) !==
      JSON.stringify(computedBases) ||
    !canonicalJsonBytes(manifest.expected.sellable_skus).equals(
      canonicalJsonBytes(computedSellable),
    )
  )
    throw new Error('MANIFEST_EXPECTED_IDENTITIES_MISMATCH');
  if (
    manifest.expected.excluded_product_ids.some(
      (id) =>
        computedIds.includes(id) &&
        manifest.expected.sellable_skus.some((sku) => sku.product_id === id),
    )
  )
    throw new Error('MANIFEST_INELIGIBLE_PRODUCT_SELLABLE');
  return true;
}

export async function writeCanonicalFixture() {
  const bytes = canonicalJsonBytes(buildManifest());
  const checksum = `${sha256(bytes)}  manifest.json\n`;
  await writeFile(MANIFEST_PATH, bytes);
  await writeFile(CHECKSUM_PATH, checksum, 'utf8');
  return { sha256: sha256(bytes), bytes: bytes.length };
}

export async function checkCanonicalFixture() {
  const [bytes, checksumText] = await Promise.all([
    readFile(MANIFEST_PATH),
    readFile(CHECKSUM_PATH, 'utf8'),
  ]);
  verifyManifestBytes(bytes, checksumText);
  if (!bytes.equals(canonicalJsonBytes(buildManifest())))
    throw new Error('MANIFEST_DIFFERS_FROM_SEEDED_SOURCE');
  return { sha256: sha256(bytes), bytes: bytes.length };
}

export async function prepareFixture(mode = 'dry-run') {
  const result = await checkCanonicalFixture();
  if (mode !== 'dry-run')
    throw new Error('APPLY_REQUIRES_REGISTERED_DOMAIN_HARNESSES');
  return { ...result, mode: 'dry-run', writes: 0, resources: 0 };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const result = process.argv.includes('--write')
      ? await writeCanonicalFixture()
      : await prepareFixture(
          process.argv.includes('--apply') ? 'apply' : 'dry-run',
        );
    process.stdout.write(
      `${result.mode === 'dry-run' ? 'DRY_RUN' : 'WROTE'} catalog H5 fixture ${result.sha256} (${result.bytes} bytes); writes=${result.writes ?? 1}; resources=${result.resources ?? 0}\n`,
    );
  } catch (error) {
    process.stderr.write(
      `FIXTURE_INVALID ${error instanceof Error ? error.message : 'UNKNOWN'}\n`,
    );
    process.exitCode = 1;
  }
}
