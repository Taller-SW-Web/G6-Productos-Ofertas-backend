import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import {
  buildManifest,
  canonicalJsonBytes,
  checkCanonicalFixture,
  FIXTURE_SEED,
  MANIFEST_PATH,
  CHECKSUM_PATH,
  prepareFixture,
  sha256,
  validateManifest,
  verifyManifestBytes,
} from './catalog-h5-fixture.mjs';

describe('manifest canónico Poma H5', () => {
  it('usa la semilla compartida y produce bytes deterministas', () => {
    const first = canonicalJsonBytes(buildManifest(FIXTURE_SEED));
    const second = canonicalJsonBytes(buildManifest(FIXTURE_SEED));
    expect(first.equals(second)).toBe(true);
    expect(FIXTURE_SEED).toBe(20261123);
  });

  it('conserva bytes canónicos UTF-8 sin BOM ni CRLF y SHA-256 verificable', async () => {
    const [bytes, checksum] = await Promise.all([
      readFile(MANIFEST_PATH),
      readFile(CHECKSUM_PATH, 'utf8'),
    ]);
    expect(bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(
      false,
    );
    expect(bytes.includes(0x0d)).toBe(false);
    expect(checksum).toBe(`${sha256(bytes)}  manifest.json\n`);
    expect(verifyManifestBytes(bytes, checksum).schema_version).toBe(1);
    expect(await checkCanonicalFixture()).toMatchObject({
      sha256: sha256(bytes),
    });
  });

  it('define identidades completas y un ordenamiento de paginación estable', () => {
    const manifest = buildManifest();
    expect(manifest.products).toHaveLength(25);
    expect(manifest.expected.product_ids).toHaveLength(25);
    expect(manifest.expected.sku_bases).toHaveLength(25);
    for (const channel of ['MARKETPLACE', 'CHATBOT', 'RETAIL', 'VENTAS']) {
      expect(manifest.expected.commercial_product_ids_by_channel[channel]).toEqual(
        manifest.expected.commercial_product_ids_by_channel.MARKETPLACE,
      );
    }
    expect(manifest.products
      .filter(({ eligible_channels }) => eligible_channels.includes('MARKETPLACE'))
      .map(({ product_id }) => product_id).sort()).toEqual(manifest.expected.commercial_product_ids_by_channel.MARKETPLACE);
    expect(manifest.pagination).toEqual({
      page_size: 10,
      stable_sort: 'nombre:asc,product_id:asc',
    });
    expect(manifest.expected.sellable_skus).toContainEqual(
      expect.objectContaining({ sku: 'POMA-H5-VAR-RED-S-0002' }),
    );
    expect(manifest.expected.sellable_skus).not.toContainEqual(
      expect.objectContaining({ sku: 'POMA-H5-VAR-DISABLED-0004' }),
    );
    expect(
      manifest.expected.sellable_skus.some(({ product_id }) =>
        manifest.expected.excluded_product_ids.includes(product_id),
      ),
    ).toBe(false);
  });

  it('rechaza checksum alterado, BOM y CRLF', async () => {
    const [bytes, checksum] = await Promise.all([
      readFile(MANIFEST_PATH),
      readFile(CHECKSUM_PATH, 'utf8'),
    ]);
    const altered = Buffer.from(bytes);
    altered[altered.length - 2] ^= 1;
    expect(() => verifyManifestBytes(altered, checksum)).toThrow(
      'MANIFEST_CHECKSUM_MISMATCH',
    );
    expect(() =>
      verifyManifestBytes(
        Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes]),
        checksum,
      ),
    ).toThrow('MANIFEST_BOM');
    expect(() =>
      verifyManifestBytes(
        Buffer.from(bytes.toString('utf8').replaceAll('\n', '\r\n')),
        checksum,
      ),
    ).toThrow('MANIFEST_CRLF');
  });

  it('rechaza identidades duplicadas y conjuntos esperados inconsistentes', () => {
    const duplicate = structuredClone(buildManifest());
    duplicate.products[1].product_id = duplicate.products[0].product_id;
    expect(() => validateManifest(duplicate)).toThrow(
      'MANIFEST_DUPLICATE_PRODUCT_ID',
    );
    const missing = structuredClone(buildManifest());
    missing.expected.sku_bases.pop();
    expect(() => validateManifest(missing)).toThrow(
      'MANIFEST_EXPECTED_IDENTITIES_MISMATCH',
    );
    const channelMismatch = structuredClone(buildManifest());
    channelMismatch.products.find(({ eligible_channels }) => eligible_channels.includes('MARKETPLACE'))!.eligible_channels = [];
    expect(() => validateManifest(channelMismatch)).toThrow('MANIFEST_EXPECTED_IDENTITIES_MISMATCH');
  });

  it('mantiene dry-run sin escrituras y bloquea apply sin harnesses de dominio registrados', async () => {
    await expect(prepareFixture()).resolves.toMatchObject({
      mode: 'dry-run',
      writes: 0,
      resources: 0,
    });
    await expect(prepareFixture('apply')).rejects.toThrow(
      'APPLY_REQUIRES_REGISTERED_DOMAIN_HARNESSES',
    );
  });

  it('incluye precio de canal, precio global alternativo, ausencia de precio y stock no observado', () => {
    const manifest = buildManifest();
    expect(
      manifest.pricing.some((price) => price.channel_id === 'MARKETPLACE'),
    ).toBe(true);
    expect(manifest.pricing.some((price) => price.channel_id === null)).toBe(
      true,
    );
    expect(
      manifest.pricing.some((price) => price.sku === 'POMA-H5-NO-PRICE-0005'),
    ).toBe(false);
    expect(
      manifest.inventory.some((stock) => stock.sku === 'POMA-H5-NO-STOCK-0006'),
    ).toBe(false);
  });
});
