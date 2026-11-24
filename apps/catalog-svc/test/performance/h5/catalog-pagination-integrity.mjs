function sorted(values) {
  return [...values].sort((left, right) => left.localeCompare(right, 'en'));
}

export function validateCatalogSnapshot({ pages, variantsByProduct, manifest }) {
  const findings = [];
  const expectedProducts = manifest.products
    .filter((product) => product.eligible && product.state === 'ACTIVO')
    .sort((left, right) => left.nombre.localeCompare(right.nombre, 'es') || left.product_id.localeCompare(right.product_id, 'en'));
  const expectedIds = expectedProducts.map(({ product_id }) => product_id);
  const allProductIds = manifest.products.map(({ product_id }) => product_id);
  const allSkuBases = manifest.products.map(({ sku_base }) => sku_base);
  const excluded = new Set(manifest.expected.excluded_product_ids);
  const idsFromManifestOracle = manifest.expected.product_ids.filter((id) => !excluded.has(id));
  const actualProducts = pages.flatMap((page) => page.items ?? []);
  const actualIds = actualProducts.map(({ product_id, productId }) => product_id ?? productId);
  const expectedPageCount = Math.ceil(expectedProducts.length / manifest.pagination.page_size);

  if (manifest.pagination.stable_sort !== 'nombre:asc,product_id:asc') findings.push('MANIFEST_SORT_UNSUPPORTED');
  if (new Set(allProductIds).size !== allProductIds.length || new Set(manifest.expected.product_ids).size !== manifest.expected.product_ids.length)
    findings.push('MANIFEST_DUPLICATE_PRODUCT_ID');
  if (new Set(allSkuBases).size !== allSkuBases.length || new Set(manifest.expected.sku_bases).size !== manifest.expected.sku_bases.length)
    findings.push('MANIFEST_DUPLICATE_SKU_BASE');
  if (sorted(allProductIds).join('\n') !== sorted(manifest.expected.product_ids).join('\n')) findings.push('MANIFEST_PRODUCT_ID_ORACLE_MISMATCH');
  if (sorted(allSkuBases).join('\n') !== sorted(manifest.expected.sku_bases).join('\n')) findings.push('MANIFEST_SKU_BASE_ORACLE_MISMATCH');
  if (sorted(idsFromManifestOracle).join('\n') !== sorted(expectedIds).join('\n')) findings.push('MANIFEST_ELIGIBILITY_ORACLE_MISMATCH');
  if (pages.length !== expectedPageCount) findings.push('PAGE_COUNT_MISMATCH');
  pages.forEach((page, index) => {
    const expectedItems = expectedProducts.slice(index * manifest.pagination.page_size, (index + 1) * manifest.pagination.page_size);
    if (page.meta?.pagina !== index + 1 || page.meta?.tamanio !== manifest.pagination.page_size || page.meta?.total !== expectedProducts.length || page.meta?.totalPaginas !== expectedPageCount)
      findings.push('PAGINATION_METADATA_MISMATCH');
    if (page.items?.length !== expectedItems.length) findings.push('PAGE_SIZE_MISMATCH');
    page.items?.forEach((row, rowIndex) => {
      const expected = expectedItems[rowIndex];
      const productId = row.product_id ?? row.productId;
      const skuBase = row.sku_base ?? row.skuBase;
      if (!expected || productId !== expected.product_id || row.nombre !== expected.nombre) findings.push('PAGE_ORDER_OR_PRODUCT_ID_MISMATCH');
      else if (skuBase !== expected.sku_base) findings.push('SKU_BASE_MISMATCH');
    });
  });

  if (new Set(actualIds).size !== actualIds.length) findings.push('DUPLICATE_PRODUCT_ID');
  const actualSkuBases = actualProducts.map(({ sku_base, skuBase }) => sku_base ?? skuBase);
  if (new Set(actualSkuBases).size !== actualSkuBases.length) findings.push('DUPLICATE_SKU_BASE');
  if (actualIds.some((id) => excluded.has(id))) findings.push('INELIGIBLE_PRODUCT_PRESENT');
  if (actualIds.some((id) => !expectedIds.includes(id))) findings.push('UNEXPECTED_PRODUCT_PRESENT');
  if (expectedIds.some((id) => !actualIds.includes(id))) findings.push('PRODUCT_MISSING');
  if (actualIds.length === expectedIds.length && actualIds.some((id, index) => id !== expectedIds[index])) findings.push('GLOBAL_ORDER_UNSTABLE');

  const expectedSkus = manifest.expected.sellable_skus;
  const actualSkus = [];
  for (const product of expectedProducts) {
    if (product.variants.length === 0) {
      actualSkus.push({ product_id: product.product_id, sku: product.sku_base, variant_id: null });
      continue;
    }
    const rows = variantsByProduct?.[product.product_id];
    if (!Array.isArray(rows)) {
      findings.push('VARIANT_PAGE_MISSING');
      continue;
    }
    const expectedVariants = product.variants.filter((variant) => variant.eligible);
    if (rows.length !== expectedVariants.length) findings.push('VARIANT_SET_MISMATCH');
    for (const variant of rows) {
      actualSkus.push({ product_id: product.product_id, sku: variant.sku, variant_id: variant.variant_id });
      if (!expectedVariants.some((expected) => expected.sku === variant.sku && expected.variant_id === variant.variant_id))
        findings.push('UNEXPECTED_OR_INELIGIBLE_VARIANT');
    }
  }
  const skuKeys = actualSkus.map(({ product_id, sku, variant_id }) => `${product_id}:${variant_id ?? 'base'}:${sku}`);
  if (new Set(skuKeys).size !== skuKeys.length) findings.push('DUPLICATE_SELLABLE_SKU');
  const skuNames = actualSkus.map(({ sku }) => sku);
  const variantIds = actualSkus.map(({ variant_id }) => variant_id).filter(Boolean);
  if (new Set(skuNames).size !== skuNames.length) findings.push('DUPLICATE_SKU_VALUE');
  if (new Set(variantIds).size !== variantIds.length) findings.push('DUPLICATE_VARIANT_ID');
  if (sorted(skuKeys).join('\n') !== sorted(expectedSkus.map(({ product_id, sku, variant_id }) => `${product_id}:${variant_id ?? 'base'}:${sku}`)).join('\n'))
    findings.push('SELLABLE_SKU_SET_MISMATCH');

  return { status: findings.length === 0 ? 'PASS' : 'FAIL', findings: [...new Set(findings)], productCount: actualProducts.length, sellableSkuCount: actualSkus.length, pages: pages.length };
}
