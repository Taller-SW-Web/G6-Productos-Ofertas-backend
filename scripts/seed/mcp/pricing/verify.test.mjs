import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (name) => readFileSync(new URL(name, import.meta.url), 'utf8');
const manifest = JSON.parse(read('manifest.json'));
const matrix = JSON.parse(read('003_price_matrix.json'));
const evidence = JSON.parse(read('004_read_only_evidence.json'));
const cents = (value) => {
  assert.match(value, /^\d+\.\d{2}$/);
  return BigInt(value.replace('.', ''));
};

function assertIdentity(row, catalog) {
  const identity = catalog.sku_identities.find((s) => s.id === row.sku_identity_id);
  assert.ok(identity, `Falta identidad en la matriz para ${row.sku}`);
  assert.equal(identity.sku, row.sku);
  if (row.kind === 'VARIANTE') {
    assert.equal(identity.product_id, null);
    assert.equal(identity.variant_id, row.variant_id);
    const variant = catalog.variants.find((v) => v.id === identity.variant_id);
    assert.ok(variant);
    assert.equal(variant.product_id, row.product_id);
  } else {
    assert.equal(identity.variant_id, null);
    assert.equal(identity.product_id, row.product_id);
  }
}

test('el manifiesto identifica el destino y verifica el SHA-256 de cada artefacto', () => {
  assert.equal(manifest.project.id, 'slzglmtiyrzygpkiuthf');
  assert.equal(manifest.project.organization_id, 'dqnklswllanhjwhenita');
  for (const [name, hash] of Object.entries(manifest.sha256)) {
    assert.equal(createHash('sha256').update(readFileSync(new URL(name, import.meta.url))).digest('hex'), hash, name);
  }
});

test('auditoria real con rol seed, solo lectura y constraints e indices presentes', () => {
  const audit = evidence.pricing;
  assert.equal(audit.effective_role, 'po_pricing_seed');
  assert.equal(audit.transaction_read_only, 'on');
  assert.equal(audit.invariants_status, 'PASS');
  assert.deepEqual(audit.issues, []);
  assert.ok(audit.counts.prices > 0, 'una muestra vacia no acredita precios');
  assert.equal(audit.counts.prices, audit.snapshots.length);
  for (const name of ['uq_prices_target_channel', 'ck_prices_target',
    'ck_price_validities_no_overlap', 'fk_price_validities_price_id',
    'uq_price_validities_price_version', 'trg_prices_timeline', 'trg_price_validities_timeline']) {
    assert.ok(audit.constraints.some((c) => c.name === name), name);
  }
  assert.ok(audit.indexes.every((i) => i.valid && i.ready));
  assert.ok(audit.triggers.every((t) => t.enabled === 'O'));
  for (const table of audit.tables) {
    assert.equal(table.can_select, true);
    assert.equal(table.can_update, false);
    assert.equal(table.can_delete, false);
    assert.equal(table.can_truncate, false);
  }
});

test('importes exactos, escala deportiva y ausencia de descuentos o historiales inventados', () => {
  for (const row of matrix.rows) {
    const price = evidence.pricing.snapshots.find((p) => p.price_id === row.price_id);
    assert.ok(price);
    for (const key of ['product_id', 'validity_id', 'precio_regular', 'precio_oferta',
      'currency', 'channel_id', 'valid_from', 'valid_until', 'price_version', 'effective_now']) {
      assert.equal(row[key], price[key], key);
    }
    assert.equal(row.precio_oferta, null);
    assert.equal(row.currency, 'PEN');
    assert.ok(row.channel_id === null || matrix.valid_channels.includes(row.channel_id));
    const scale = matrix.scales.find((s) => s.products.includes(row.product_id));
    assert.ok(scale, row.sku);
    assert.ok(cents(row.precio_regular) >= cents(scale.range_pen[0]));
    assert.ok(cents(row.precio_regular) <= cents(scale.range_pen[1]));
    assert.ok(price.motivo_cambio.trim());
    assert.equal(price.usuario_id, null, 'no atribuir un actor historico inventado');
    assert.equal(price.price_version, price.validity_version);
  }
});

test('las vigencias son efectivas al auditar y no se solapan por definicion', () => {
  const snapshots = evidence.pricing.snapshots;
  const at = Date.parse(evidence.pricing.captured_at);
  assert.equal(evidence.pricing.counts.effective_validities, snapshots.length);
  for (const a of snapshots) {
    assert.equal(a.is_cancelled, false);
    const start = Date.parse(a.valid_from);
    const end = a.valid_until === null ? Infinity : Date.parse(a.valid_until);
    assert.ok(start <= at && at < end);
    for (const b of snapshots) {
      if (a.validity_id === b.validity_id || a.price_id !== b.price_id || b.is_cancelled) continue;
      assert.ok(end <= Date.parse(b.valid_from) ||
        (b.valid_until !== null && Date.parse(b.valid_until) <= start));
    }
  }
});

test('matriz completa: producto simple, bases no vendibles y variantes con herencia', () => {
  const { catalog } = evidence;
  assert.equal(matrix.rows.length, catalog.products.length + catalog.variants.length);
  assert.equal(new Set(matrix.rows.map((r) => r.sku)).size, matrix.rows.length);
  for (const row of matrix.rows) {
    const product = catalog.products.find((p) => p.id === row.product_id);
    assert.ok(product);
    assert.equal(row.product_version, product.catalog_version);
    assert.equal(row.product_status, product.estado);
    assert.equal(row.origen, 'PRODUCTO');
    if (row.kind === 'VARIANTE') {
      const variant = catalog.variants.find((v) => v.id === row.variant_id);
      assert.ok(variant);
      assert.equal(variant.sku, row.sku);
      assert.equal(variant.product_id, row.product_id);
      assert.equal(variant.catalog_version, row.variant_version);
      assert.equal(variant.estado, row.variant_status);
    } else {
      assert.equal(row.sku, product.sku_base);
      assert.equal(row.kind, product.tiene_variantes ? 'BASE_NO_VENDIBLE' : 'SIMPLE');
    }
    assertIdentity(row, catalog);
  }
});

test('regresion: rechaza identidad omitida, SKU ajeno y propietario doble', () => {
  const { catalog } = evidence;
  assert.equal(catalog.sku_identities.length, catalog.products.length + catalog.variants.length);
  for (const identity of catalog.sku_identities) {
    assert.notEqual(identity.product_id === null, identity.variant_id === null);
  }
  const variant = matrix.rows.find((r) => r.kind === 'VARIANTE');
  assertIdentity(variant, catalog);
  assert.throws(() => assertIdentity({ ...variant, sku_identity_id: null }, catalog));
  assert.throws(() => assertIdentity({ ...variant, sku: 'SKU-AJENO' }, catalog));
  const invalid = structuredClone(catalog);
  invalid.sku_identities.find((s) => s.id === variant.sku_identity_id).product_id = variant.product_id;
  assert.throws(() => assertIdentity(variant, invalid));
});

test('no se acredita publicacion comercial, carga o autenticacion individual inexistente', () => {
  assert.equal(evidence.catalog.transaction_read_only, 'on');
  assert.equal(evidence.catalog.published_sellable_skus, 0);
  assert.equal(evidence.catalog.variants_without_identity,
    matrix.rows.filter((r) => r.kind === 'VARIANTE' && r.sku_identity_id === null).length);
  assert.ok(matrix.rows.every((r) => !r.commercial_ready && r.blockers.length > 0));
  assert.deepEqual(manifest.write_batch.rows, []);
  assert.equal(manifest.write_batch.new_prices, 0);
  assert.equal(manifest.write_batch.new_validities, 0);
  assert.equal(manifest.execution.mode, 'READ_ONLY');
  assert.equal(manifest.execution.write_rollback, 'NO EJECUTADO');
  assert.equal(manifest.execution.persistence, 'NO EJECUTADO');
  assert.equal(manifest.execution.individual_seed_login, 'NO ACREDITADO');
});

test('regresion SQL: seis variantes validas cuentan a traves de su padre', () => {
  const regression = evidence.identity_sql_regression;
  assert.equal(regression.old.published_sellable_skus, 1);
  assert.equal(regression.old.variants_without_identity, 6);
  assert.equal(regression.fixed.published_sellable_skus, regression.expected_published_sellable_skus);
  assert.equal(regression.fixed.variants_without_identity, 0);
  assert.equal(regression.fixed.transaction_read_only, 'on');
  const sql = read('002_catalog_references.sql');
  assert.match(sql, /JOIN catalog\.variants v ON v\.id = s\.variant_id AND v\.sku = s\.sku/);
  assert.match(sql, /JOIN catalog\.products p ON p\.id = v\.product_id/);
  assert.doesNotMatch(sql, /s\.product_id = v\.product_id/);
});

test('SQL acotado a lectura y sin joins entre bounded contexts', () => {
  for (const [name, schema] of [['001_pricing_audit.sql', 'pricing'], ['002_catalog_references.sql', 'catalog']]) {
    const sql = read(name).replace(/--[^\n]*/g, '').replace(/'(?:''|[^'])*'/g, "''");
    assert.match(sql, /BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY/i);
    assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|CREATE|DROP|GRANT|REVOKE|CALL|DO|COPY)\b/i);
    assert.doesNotMatch(sql, /\b(public|auth|price_audit|promotions|combos|inventory|bulk|taxonomy)\./i);
    assert.doesNotMatch(sql, schema === 'pricing' ? /\bcatalog\./i : /\bpricing\./i);
  }
  assert.match(read('001_pricing_audit.sql'), /SET LOCAL ROLE po_pricing_seed/);
});
