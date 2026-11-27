import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const BACKEND_ROOT = resolve(process.cwd());
const FRONTEND_ROOT = resolve(process.env.G6_FRONTEND_ROOT ?? resolve(BACKEND_ROOT, "../frontend"));
const DOCS_ROOT = resolve(process.env.G6_DOCS_ROOT ?? resolve(BACKEND_ROOT, "../docs"));
const MANIFEST_PATH = resolve(FRONTEND_ROOT, "tests/e2e-real/.runtime-stack.json");
const REPORT_DIR = resolve(process.env.G6_MESSAGING_REPORT_DIR ?? resolve(BACKEND_ROOT, "tests/h5"));
const REPORT_JSON_PATH = resolve(REPORT_DIR, "MENSAJERIA_19_RECORRIDOS.json");
const REPORT_CSV_PATH = resolve(REPORT_DIR, "MENSAJERIA_19_RECORRIDOS.csv");
const VALID_PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=",
  "base64",
);

function requireSeedResult(label, res, pred = (r) => r.status >= 200 && r.status < 300) {
  if (!res || !pred(res)) {
    throw new Error(`SEED_FAILED ${label}: status=${res?.status ?? 0} body=${(res?.text ?? "").slice(0, 400)}`);
  }
  return res;
}

async function waitForManifest(timeoutMs = 120_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (existsSync(MANIFEST_PATH)) return JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
    await delay(500);
  }
  throw new Error("TIMEOUT esperando .runtime-stack.json");
}

async function httpCall(url, { method = "GET", headers = {}, body } = {}) {
  if (body instanceof FormData) {
    const cleanHeaders = Object.fromEntries(
      Object.entries(headers).filter(([k]) => k.toLowerCase() !== "content-type"),
    );
    const res = await fetch(url, {
      method,
      headers: { "X-Correlation-Id": randomUUID(), ...cleanHeaders },
      signal: AbortSignal.timeout(10_000),
      body,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = null; }
    return { status: res.status, text, json };
  }
  const payload = body === undefined ? undefined : (typeof body === "string" ? body : JSON.stringify(body));
  const u = new URL(url);
  const transport = u.protocol === "https:" ? https : http;
  return await new Promise((resolveReq) => {
    const req = transport.request(
      {
        hostname: u.hostname,
        port: Number(u.port || (u.protocol === "https:" ? 443 : 80)),
        path: `${u.pathname}${u.search}`,
        method,
        agent: false,
        ...(u.protocol === "https:" ? { rejectUnauthorized: false } : {}),
        headers: {
          "X-Correlation-Id": randomUUID(),
          Connection: "close",
          ...headers,
          ...(payload !== undefined ? { "content-type": "application/json", "Content-Length": String(Buffer.byteLength(payload)) } : {}),
        },
        timeout: 8_000,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try { json = JSON.parse(text); } catch { json = null; }
          resolveReq({ status: res.statusCode ?? 0, text, json });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("Request timeout")));
    req.on("error", (err) => resolveReq({ status: 0, text: err.message, json: null }));
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

async function pgSelect(g5SeedOrigin, sql) {
  const res = await httpCall(`${g5SeedOrigin}/__test/pg-query`, { method: "POST", body: { sql } });
  if (res.status !== 200 || !Array.isArray(res.json?.rows)) {
    throw new Error(`PG_QUERY_FAILED status=${res.status} body=${res.text}`);
  }
  return res.json.rows;
}

async function pollUntil(fn, pred, attempts = 50, intervalMs = 300) {
  for (let i = 0; i < attempts; i++) {
    const r = await fn();
    if (pred(r)) return r;
    await delay(intervalMs);
  }
  return null;
}

async function loginG7(g7ApiBase, correo, contrasena) {
  const res = await httpCall(`${g7ApiBase}/auth/login`, {
    method: "POST",
    body: { correo, contrasena, formatoAcceso: "JWS" },
  });
  return res.json?.accessToken;
}

async function tokenM2M(g7ApiBase, clientId, clientSecret, scope) {
  const body = new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret, scope }).toString();
  const res = await fetch(`${g7ApiBase}/api/v1/auth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  return (await res.json())?.accessToken;
}

async function main() {
  rmSync(MANIFEST_PATH, { force: true });
  let stackLogs = "";
  let stackExitCode = null;
  const stackProc = spawn("node", ["tests/e2e-real/startRealStackAndVite.mjs", "--no-vite"], {
    cwd: FRONTEND_ROOT,
    env: { ...process.env, G6_BACKEND_ROOT: BACKEND_ROOT, G6_DOCS_ROOT: DOCS_ROOT, G6_REAL_STACK_SKIP_VITE: "1" },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  stackProc.stdout.on("data", (d) => { stackLogs += d.toString(); });
  stackProc.stderr.on("data", (d) => { stackLogs += d.toString(); });
  stackProc.on("close", (code) => { stackExitCode = code; });

  const stopStack = async () => {
    if (stackProc.exitCode === null && stackProc.signalCode === null) {
      stackProc.send({ type: "G6_STACK_STOP" });
      await Promise.race([new Promise((r) => stackProc.once("exit", r)), delay(8000)]);
      if (stackProc.exitCode === null && stackProc.signalCode === null) stackProc.kill("SIGKILL");
    }
  };

  let exitCode = 1;
  try {
    const env = await waitForManifest(120_000);
    const gw = env.gatewayUrl;
    const gestorJwt = await loginG7(env.g7ApiBase, "gestor@example.test", "isolated-g7-password");
    if (!gestorJwt) throw new Error("G7_LOGIN_FAILED for gestor@example.test");
    const g5Token = await tokenM2M(env.g7ApiBase, "modulo-ventas", "e2e-ventas-secret", "cupones:consumir cupones:restaurar cupones:operaciones:leer inventario:reservar inventario:consumir inventario:liberar inventario:operaciones:leer inventario:reservas:estado:leer");
    const authH = { Authorization: `Bearer ${gestorJwt}` };

    // Base masters
    const catRes = requireSeedResult("crearCategoria", await httpCall(`${gw}/api/v1/categorias`, { method: "POST", headers: authH, body: { nombre: `CatM-${randomUUID().slice(0, 6)}`, slugConfirmado: `catm-${randomUUID().slice(0, 6)}`, categoriaPadreId: null } }));
    const catId = catRes.json?.categoriaId;
    const brandForm = new FormData();
    brandForm.append("nombre", `MarcaM-${randomUUID().slice(0, 6)}`);
    brandForm.append("logo", new Blob([VALID_PNG_BYTES], { type: "image/png" }), "l.png");
    const brandRes = requireSeedResult("crearMarca", await httpCall(`${gw}/api/v1/marcas`, { method: "POST", headers: authH, body: brandForm }));
    const brandId = brandRes.json?.marcaId;
    const typeRes = requireSeedResult("crearTipoProducto", await httpCall(`${gw}/api/v1/tipos-producto`, { method: "POST", headers: authH, body: { nombre: `TipoM-${randomUUID().slice(0, 6)}` } }));
    const typeId = typeRes.json?.tipoProductoId;

    // 1. Trigger R01/R02/R03/R04/R10/R14 via Bulk CSV V2 (schema v3 claim check)
    const bulkSku = `BULK-MSG-${randomUUID().slice(0, 6).toUpperCase()}`;
    const v2Headers = "operacion,producto_id,catalog_version,sku_base,sku_variante,nombre,descripcion,categoria_id,marca_id,tipo_producto_id,tiene_variantes,precio_regular,atributos_producto,atributos_variante,imagen_url,stock_inicial";
    const bulkRow = ["ALTA", "", "", bulkSku, "", "Prod Msg", "Desc Msg", catId, brandId, typeId, "false", "75.00", "[]", "", "https://example.test/m.png", "20"].join(",");
    const bulkForm = new FormData();
    bulkForm.append("archivo", new Blob([`${v2Headers}\r\n${bulkRow}\r\n`], { type: "text/csv" }), "msg.csv");
    const bulkUp = requireSeedResult("crearImportacionGeneralProductos", await httpCall(`${gw}/api/v1/carga-masiva/productos/importaciones`, { method: "POST", headers: { Authorization: `Bearer ${gestorJwt}`, "Idempotency-Key": randomUUID() }, body: bulkForm }));
    const batchId = bulkUp.json?.batch_id;
    const bulkDone = await pollUntil(() => httpCall(`${gw}/api/v1/carga-masiva/productos/importaciones/${batchId}`, { headers: authH }), (r) => r.json?.status === "COMPLETED", 60, 400);
    if (bulkDone?.json?.status !== "COMPLETED") throw new Error(`BULK_SEED_NOT_COMPLETED: ${JSON.stringify(bulkDone?.json)}`);
    const bulkProdRows = await pgSelect(env.g5SeedOrigin, `SELECT id::text AS id FROM catalog.products WHERE sku_base = '${bulkSku}'`);
    const bulkProdId = bulkProdRows[0]?.id;
    if (!bulkProdId) throw new Error(`BULK_PRODUCT_NOT_FOUND for ${bulkSku}`);
    requireSeedResult("completarPerfilBulk", await httpCall(`${gw}/api/v1/productos/${bulkProdId}`, { method: "PATCH", headers: authH, body: { perfilFisico: { pesoKg: 0.2, dimensionesCm: { alto: 5, ancho: 5, largo: 5 } } } }));
    const bulkReady = await pollUntil(() => pgSelect(env.g5SeedOrigin, `SELECT count(*)::int AS c FROM catalog.activation_checks WHERE product_id = '${bulkProdId}'::uuid AND state = 'COMPLETED'`), (rows) => Number(rows[0]?.c) === 2);
    if (!bulkReady) throw new Error("BULK_PREPARATION_NOT_COMPLETED");
    requireSeedResult("activarProductoBulk", await httpCall(`${gw}/api/v1/productos/${bulkProdId}/activar`, { method: "POST", headers: { ...authH, "Idempotency-Key": randomUUID() }, body: {} }));

    // 2. Trigger R06/R07/R11/R15 via administrative product creation + activation
    const admSku = `ADM-MSG-${randomUUID().slice(0, 6).toUpperCase()}`;
    const prodRes = requireSeedResult("crearProducto", await httpCall(`${gw}/api/v1/productos`, {
      method: "POST",
      headers: { ...authH, "Idempotency-Key": randomUUID() },
      body: { nombre: `Prod Adm ${admSku}`, descripcion: "Desc", categoriaId: catId, tipoProductoId: typeId, marcaId: brandId, tieneVariantes: false, skuBase: admSku, precioBaseInicial: 90, imagenes: [{ url: "https://example.test/a.png", principal: true }], perfilFisico: { pesoKg: 0.2, dimensionesCm: { alto: 5, ancho: 5, largo: 5 } } },
    }));
    const admProdId = prodRes.json?.productoId ?? prodRes.json?.product_id ?? prodRes.json?.id;
    if (!admProdId || !/^[0-9a-f-]{36}$/i.test(String(admProdId))) {
      throw new Error(`SEED_FAILED crearProducto missing productoId: status=${prodRes.status} body=${(prodRes.text ?? "").slice(0, 400)}`);
    }
    const checksReady = await pollUntil(
      () => pgSelect(env.g5SeedOrigin, `SELECT count(*)::int AS c FROM catalog.activation_checks WHERE product_id = '${admProdId}'::uuid AND state = 'COMPLETED'`),
      (rows) => Number(rows[0]?.c ?? 0) === 2,
      40,
      300,
    );
    if (Number(checksReady?.[0]?.c ?? 0) !== 2) {
      const checks = await pgSelect(env.g5SeedOrigin, `SELECT dependency, state, result_payload FROM catalog.activation_checks WHERE product_id = '${admProdId}'::uuid`);
      const diagnostic = {
        checks,
        catalogOutbox: await pgSelect(env.g5SeedOrigin, `SELECT event_name, payload, published_at FROM catalog.outbox WHERE payload::text LIKE '%${admProdId}%'`),
        pricingInbox: await pgSelect(env.g5SeedOrigin, `SELECT payload, result FROM pricing.inbox WHERE payload::text LIKE '%${admProdId}%'`),
        pricingOutbox: await pgSelect(env.g5SeedOrigin, `SELECT event_name, payload FROM pricing.outbox WHERE payload::text LIKE '%${admProdId}%'`),
        queues: await Promise.all(["g6.pricing.from.catalog", "g6.catalog.from.pricing"].map(async (q) => ({ queue: q, pending: (await httpCall(`${env.isolatedBusUrl}/queues/${q}/peek`)).json, dlq: (await httpCall(`${env.isolatedBusUrl}/queues/${q}/dlq`)).json }))),
      };
      throw new Error(`ACTIVATION_CHECKS_NOT_COMPLETED for ${admProdId}: ${JSON.stringify(diagnostic)}`);
    }
    requireSeedResult("activarProducto", await httpCall(`${gw}/api/v1/productos/${admProdId}/activar`, { method: "POST", headers: { ...authH, "Idempotency-Key": randomUUID() }, body: {} }));
    // R06 initializes identity with zero balance. Stock for the reservation is
    // explicit disposable fixture data, not evidence of a receiving operation.
    requireSeedResult("stockFixtureAdministrativo", await httpCall(`${env.g5SeedOrigin}/__test/inventory-stock`, { method: "POST", body: { sku: admSku, on_hand: 20 } }));
    const combo = requireSeedResult("crearCombo", await httpCall(`${gw}/api/v1/combos/administracion`, { method: "POST", headers: { ...authH, "Idempotency-Key": randomUUID() }, body: { nombre: `Combo ${admSku}`, componentes: [{ sku: admSku, cantidad: 1 }, { sku: bulkSku, cantidad: 1 }], precioCombo: 150 } }));
    const comboId = combo.json?.combo_id ?? combo.json?.comboId ?? combo.json?.id;
    if (!comboId || !/^[0-9a-f-]{36}$/i.test(String(comboId))) {
      throw new Error(`SEED_FAILED crearCombo missing combo_id: status=${combo.status} body=${(combo.text ?? "").slice(0, 400)}`);
    }

    // 3. Trigger R16/R17 via PATCH precio SKU
    requireSeedResult("actualizarPrecioSku", await httpCall(`${gw}/api/v1/precios/skus/${admSku}`, {
      method: "PATCH",
      headers: { ...authH, "Idempotency-Key": randomUUID() },
      body: { accionPrecioOferta: "CONSERVAR", priceVersion: 0, precioRegular: 95, moneda: "PEN", channelId: "MARKETPLACE", motivoCambio: "MSG_TEST_R16_R17" },
    }));

    // 4. Trigger R12/R13 via Inventory reservation
    const resOrderId = randomUUID();
    const resOpId = randomUUID();
    requireSeedResult("solicitarReserva", await httpCall(`${gw}/api/v1/inventario/reservas`, {
      method: "POST",
      headers: { Authorization: `Bearer ${g5Token}`, "Idempotency-Key": resOpId },
      body: { order_id: resOrderId, operation_id: resOpId, channel_id: "MARKETPLACE", lines: [{ sku: admSku, quantity: 1, location_id: "00000000-0000-4000-8000-000000000101" }] },
    }));
    const resPoll = await pollUntil(() => httpCall(`${gw}/api/v1/inventario/operaciones/${resOpId}`, { headers: { Authorization: `Bearer ${g5Token}` } }), (r) => r.json?.status === "COMPLETED", 40, 300);
    if (resPoll?.json?.status !== "COMPLETED") throw new Error(`RESERVATION_NOT_COMPLETED: ${JSON.stringify(resPoll?.json)}`);

    // 5. Trigger R05/R06(deact)/R07(deact)/R08 via product deactivation
    requireSeedResult("desactivarProducto", await httpCall(`${gw}/api/v1/productos/${admProdId}/desactivar`, { method: "POST", headers: { ...authH, "Idempotency-Key": randomUUID() }, body: {} }));

    // 6. Trigger R18/R09 via Taxonomy deactivation request
    const catDeact = requireSeedResult("crearCategoriaDeact", await httpCall(`${gw}/api/v1/categorias`, { method: "POST", headers: authH, body: { nombre: `CatD-${randomUUID().slice(0, 6)}`, slugConfirmado: `catd-${randomUUID().slice(0, 6)}`, categoriaPadreId: null } }));
    const catDeactId = catDeact.json?.categoriaId;
    const taxOp = requireSeedResult("solicitarDesactivacionCategoria", await httpCall(`${gw}/api/v1/categorias/${catDeactId}/desactivar`, { method: "POST", headers: authH }));
    const taxOpId = taxOp.json?.operation_id ?? taxOp.json?.operacionId;
    if (taxOpId) {
      await pollUntil(() => httpCall(`${gw}/api/v1/taxonomia/operaciones/${taxOpId}`, { headers: authH }), (r) => ["COMPLETADA", "COMPLETED", "RECHAZADA", "REJECTED"].includes(r.json?.estado ?? r.json?.status), 40, 300);
    }

    // 7. Trigger N01 consume + restore on active bulk product
    const validFrom = new Date(Date.now() - 60_000).toISOString();
    const validUntil = new Date(Date.now() + 86_400_000).toISOString();
    const promoRes = requireSeedResult("crearPromocion", await httpCall(`${gw}/api/v1/promociones`, {
      method: "POST",
      headers: authH,
      body: {
        nombre: `PromoM ${randomUUID().slice(0, 5)}`,
        tipoDescuento: "PORCENTAJE",
        valor: 10,
        modalidad: "CUPON",
        estado: "ACTIVO",
        prioridad: 1,
        validFrom,
        validUntil,
        canalesHabilitados: ["MARKETPLACE"],
        alcance: { productIds: [bulkProdId] },
        politicaCombinacion: { ofertaPricing: true, promocionAutomatica: true, cupon: true },
      },
    }));
    const cpnCode = `CPNM${randomUUID().slice(0, 5).toUpperCase()}`;
    requireSeedResult("crearCupon", await httpCall(`${gw}/api/v1/cupones`, { method: "POST", headers: authH, body: { codigo: cpnCode, promocionId: promoRes.json?.promocionId ?? promoRes.json?.promotionId, estado: "ACTIVO", politicaCancelacion: "RESTAURAR_EN_CANCELACION" } }));
    const n01Order = randomUUID();
    const n01ResOp = randomUUID();
    requireSeedResult("solicitarReservaN01", await httpCall(`${gw}/api/v1/inventario/reservas`, { method: "POST", headers: { Authorization: `Bearer ${g5Token}`, "Idempotency-Key": n01ResOp }, body: { order_id: n01Order, operation_id: n01ResOp, channel_id: "MARKETPLACE", lines: [{ sku: bulkSku, quantity: 1, location_id: "00000000-0000-4000-8000-000000000101" }] } }));
    const n01ResPoll = await pollUntil(() => httpCall(`${gw}/api/v1/inventario/operaciones/${n01ResOp}`, { headers: { Authorization: `Bearer ${g5Token}` } }), (r) => Boolean(r.json?.reservation_id));
    const n01ResId = n01ResPoll?.json?.reservation_id;
    const effAt = new Date().toISOString();
    const cust = randomUUID();
    requireSeedResult("g5SnapshotN01", await httpCall(`${env.g5SeedOrigin}/__test/g5-snapshots`, { method: "POST", body: { order_id: n01Order, commercial_snapshot_ref: n01Order, channel_id: "MARKETPLACE", customer_ref: cust, coupon_code: cpnCode, reservation_id: n01ResId, lines: [{ sku: bulkSku, product_id: bulkProdId, quantity: 1, currency: "PEN", regular_price: "75.00", offer_price: null }], effective_at: effAt } }));
    const n01ConsumeOp = randomUUID();
    requireSeedResult("consumirCuponN01", await httpCall(`${gw}/api/v1/cupones/consumos`, { method: "POST", headers: { Authorization: `Bearer ${g5Token}`, "Idempotency-Key": n01ConsumeOp }, body: { operation_id: n01ConsumeOp, order_id: n01Order, coupon_code: cpnCode, customer_ref: cust, channel_id: "MARKETPLACE", effective_at: effAt, reservation_id: n01ResId, commercial_snapshot_ref: n01Order } }));
    const n01ConsumePoll = await pollUntil(() => httpCall(`${gw}/api/v1/cupones/operaciones/${n01ConsumeOp}?order_id=${n01Order}`, { headers: { Authorization: `Bearer ${g5Token}` } }), (r) => ["COMPLETED", "REJECTED"].includes(r.json?.status));
    const n01RestoreOp = randomUUID();
    requireSeedResult("restaurarCuponN01", await httpCall(`${gw}/api/v1/cupones/restauraciones`, { method: "POST", headers: { Authorization: `Bearer ${g5Token}`, "Idempotency-Key": n01RestoreOp }, body: { operation_id: n01RestoreOp, order_id: n01Order, consumption_operation_id: n01ConsumeOp, cancellation_reason: "ANULACION", cancelled_at: new Date().toISOString() } }));
    const n01RestorePoll = await pollUntil(() => httpCall(`${gw}/api/v1/cupones/operaciones/${n01RestoreOp}?order_id=${n01Order}`, { headers: { Authorization: `Bearer ${g5Token}` } }), (r) => ["COMPLETED", "REJECTED"].includes(r.json?.status));

    await delay(1000);

    // Check DB Inbox/Outbox evidence per flow linked to actual operation/product/sku
    const queryEvidence = [];
    const qCount = async (sql) => {
      try {
        const rows = await pgSelect(env.g5SeedOrigin, sql);
        queryEvidence.push({ sql, rows });
        return Number(rows[0]?.c ?? 0);
      } catch (error) {
        queryEvidence.push({ sql, error: error.message });
        return Number.NaN;
      }
    };
    const bulkSteps = bulkDone?.json?.rows?.[0]?.steps ?? [];
    const stepOk = (dom) => bulkSteps.some((s) => s.dominio === dom && s.status === "COMPLETED");

    const flows = [
      { id: "R01", cola: "g6.catalog.from.bulk", productor: "bulk-svc", consumidor: "catalog-svc", ok: stepOk("CATALOGO") && (await qCount(`SELECT count(*)::int AS c FROM catalog.outbox WHERE event_name = 'catalog.bulk.upsert.completed' AND payload::text LIKE '%${batchId}%'`)) >= 1 },
      { id: "R02", cola: "g6.inventory.from.bulk", productor: "bulk-svc", consumidor: "inventory-svc", ok: stepOk("INVENTARIO") && (await qCount(`SELECT count(*)::int AS c FROM inventory.inbox WHERE message_type = 'inventory.bulk.stock.adjust.requested' AND payload::text LIKE '%${bulkSku}%'`)) >= 1 },
      { id: "R03", cola: "g6.pricing.from.bulk", productor: "bulk-svc", consumidor: "pricing-svc", ok: stepOk("PRICING") && (await qCount(`SELECT count(*)::int AS c FROM pricing.inbox WHERE event_name = 'pricing.bulk.price.apply.requested' AND payload->'data'->>'batch_id' = '${batchId}'`)) >= 1 && (await qCount(`SELECT count(*)::int AS c FROM pricing.prices p JOIN pricing.price_validities v ON v.price_id = p.id WHERE p.sku = '${bulkSku}' AND v.precio_regular = 75 AND v.is_cancelled = false`)) === 1 },
      { id: "R04", cola: "g6.bulk.from.catalog", productor: "catalog-svc", consumidor: "bulk-svc", ok: stepOk("CATALOGO") && (await qCount(`SELECT count(*)::int AS c FROM catalog.outbox o JOIN catalog.outbox_delivery d USING (message_id) WHERE o.event_name = 'catalog.bulk.upsert.completed' AND d.destination = 'g6.bulk.from.catalog' AND d.published_at IS NOT NULL AND o.payload::text LIKE '%${batchId}%'`)) >= 1 },
      { id: "R05", cola: "g6.combos.from.catalog", productor: "catalog-svc", consumidor: "combos-svc", ok: (await qCount(`SELECT count(*)::int AS c FROM combos.inbox WHERE payload::text LIKE '%${admProdId}%' AND result = 'PROCESSED'`)) >= 1 && (await qCount(`SELECT count(*)::int AS c FROM combos.component_projection p JOIN combos.combo_items i ON i.id = p.combo_item_id WHERE i.combo_id = '${comboId}'::uuid AND i.sku = '${admSku}' AND p.catalog_deactivated = true`)) === 1 },
      { id: "R06", cola: "g6.inventory.from.catalog", productor: "catalog-svc", consumidor: "inventory-svc", ok: (await qCount(`SELECT count(*)::int AS c FROM inventory.inbox WHERE message_type = 'inventory.sku.initialization.requested' AND payload::text LIKE '%${admSku}%'`)) >= 1 },
      { id: "R07", cola: "g6.pricing.from.catalog", productor: "catalog-svc", consumidor: "pricing-svc", ok: (await qCount(`SELECT count(*)::int AS c FROM pricing.inbox WHERE event_name = 'pricing.product.initialization.requested' AND payload::text LIKE '%${admProdId}%' AND result = 'APPLIED'`)) === 1 && (await qCount(`SELECT count(*)::int AS c FROM pricing.prices WHERE product_id = '${admProdId}' AND sku IS NULL`)) === 1 },
      { id: "R08", cola: "g6.promotions.from.catalog", productor: "catalog-svc", consumidor: "promotions-svc", ok: (await qCount(`SELECT count(*)::int AS c FROM promotions.inbox WHERE envelope::text LIKE '%${admProdId}%' AND completed_at IS NOT NULL`)) >= 1 && (await qCount(`SELECT count(*)::int AS c FROM promotions.catalog_projection WHERE reference_type = 'PRODUCTO' AND reference_id = '${admProdId}' AND active = false`)) === 1 },
      { id: "R09", cola: "g6.taxonomy.from.catalog", productor: "catalog-svc", consumidor: "taxonomy-svc", ok: (await qCount(`SELECT count(*)::int AS c FROM catalog.outbox WHERE event_name = 'catalog.master.deactivation.checked' AND payload::text LIKE '%${catDeactId}%'`)) >= 1 && (await qCount(`SELECT count(*)::int AS c FROM taxonomy.inbox WHERE payload::text LIKE '%${catDeactId}%'`)) >= 1 },
      { id: "R10", cola: "g6.bulk.from.inventory", productor: "inventory-svc", consumidor: "bulk-svc", ok: stepOk("INVENTARIO") && (await qCount(`SELECT count(*)::int AS c FROM inventory.outbox WHERE event_type = 'inventory.bulk.stock.adjust.completed' AND payload::text LIKE '%${batchId}%'`)) >= 1 },
      { id: "R11", cola: "g6.catalog.from.inventory", productor: "inventory-svc", consumidor: "catalog-svc", ok: (await qCount(`SELECT count(*)::int AS c FROM catalog.activation_checks WHERE product_id = '${admProdId}'::uuid AND dependency = 'INVENTORY' AND state = 'COMPLETED'`)) >= 1 },
      { id: "R12", cola: "g6.combos.from.inventory", productor: "inventory-svc", consumidor: "combos-svc", ok: (await qCount(`SELECT count(*)::int AS c FROM combos.inbox WHERE event_name = 'inventory.stock.changed' AND payload::text LIKE '%${admSku}%' AND result = 'PROCESSED'`)) >= 1 && (await qCount(`SELECT count(*)::int AS c FROM combos.component_projection p JOIN combos.combo_items i ON i.id = p.combo_item_id WHERE i.combo_id = '${comboId}'::uuid AND i.sku = '${admSku}' AND p.inventory_observed_at IS NOT NULL`)) === 1 },
      { id: "R13", cola: "g6.promotions.from.inventory", productor: "inventory-svc", consumidor: "promotions-svc", ok: (await qCount(`SELECT count(*)::int AS c FROM promotions.inbox WHERE envelope->>'name' = 'inventory.stock.changed' AND envelope->'data'->>'sku' = '${admSku}' AND completed_at IS NOT NULL AND result->>'handled' = 'true' AND result->'invalidation'->>'domain' = 'stock' AND result->'invalidation'->>'targetId' = '${admSku}' AND result->'invalidation'->>'sourceVersion' = envelope->'data'->>'stock_version' AND result->'invalidation'->>'locationId' = envelope->'data'->>'location_id'`)) >= 1 },
      { id: "R14", cola: "g6.bulk.from.pricing", productor: "pricing-svc", consumidor: "bulk-svc", ok: stepOk("PRICING") && (await qCount(`SELECT count(*)::int AS c FROM pricing.outbox o JOIN pricing.outbox_delivery d USING (message_id) WHERE o.payload::text LIKE '%${batchId}%' AND d.destination = 'g6.bulk.from.pricing' AND d.sent_at IS NOT NULL`)) >= 1 },
      { id: "R15", cola: "g6.catalog.from.pricing", productor: "pricing-svc", consumidor: "catalog-svc", ok: (await qCount(`SELECT count(*)::int AS c FROM catalog.activation_checks WHERE product_id = '${admProdId}'::uuid AND dependency = 'PRICING' AND state = 'COMPLETED'`)) >= 1 },
      { id: "R16", cola: "g6.price-audit.from.pricing", productor: "pricing-svc", consumidor: "price-audit-svc", ok: (await qCount(`SELECT count(*)::int AS c FROM price_audit.price_audit_log WHERE sku = '${admSku}'`)) >= 1 },
      { id: "R17", cola: "g6.promotions.from.pricing", productor: "pricing-svc", consumidor: "promotions-svc", ok: (await qCount(`SELECT count(*)::int AS c FROM promotions.inbox WHERE envelope->>'name' = 'pricing.price.changed' AND envelope->'data'->>'sku' = '${admSku}' AND envelope->'data'->>'new_price' = '95.00' AND completed_at IS NOT NULL AND result->>'handled' = 'true' AND result->'invalidation'->>'domain' = 'price' AND result->'invalidation'->>'targetId' = '${admSku}' AND result->'invalidation'->>'sourceVersion' = envelope->'data'->>'price_version'`)) === 1 },
      { id: "R18", cola: "g6.catalog.from.taxonomy", productor: "taxonomy-svc", consumidor: "catalog-svc", ok: (await qCount(`SELECT count(*)::int AS c FROM taxonomy.outbox WHERE event_name = 'taxonomy.master.deactivation.check.requested' AND payload::text LIKE '%${catDeactId}%'`)) >= 1 && (await qCount(`SELECT count(*)::int AS c FROM catalog.inbox WHERE payload::text LIKE '%${catDeactId}%'`)) >= 1 },
      { id: "N01", cola: "g6.promotions.commands", productor: "promotions-svc(http)", consumidor: "promotions-svc(worker)", ok: n01ConsumePoll?.json?.status === "COMPLETED" && n01RestorePoll?.json?.status === "COMPLETED" && (await qCount(`SELECT count(*)::int AS c FROM promotions.coupon_uses WHERE order_id = '${n01Order}'`)) === 1 && (await qCount(`SELECT count(*)::int AS c FROM promotions.coupon_command_receipts WHERE operation_id = '${n01RestoreOp}'::uuid AND status = 'COMPLETED'`)) === 1 },
    ];

    const beforeReplay = requireSeedResult("brokerEvidence", await httpCall(`${env.isolatedBusUrl}/__test/broker-evidence`)).json;
    const businessTables = ['catalog.products', 'catalog.variants', 'catalog.activation_checks',
      'inventory.stock_balance', 'inventory.kardex', 'inventory.reservations',
      'pricing.prices', 'pricing.price_validities', 'combos.component_projection',
      'price_audit.price_audit_log', 'promotions.coupon_uses', 'promotions.catalog_projection'];
    const snapshot = async () => Object.fromEntries(await Promise.all(businessTables.map(async (table) => {
      const rows = await pgSelect(env.g5SeedOrigin,
        `SELECT count(*)::int AS count, md5(coalesce(string_agg(row_to_json(t)::text, '' ORDER BY row_to_json(t)::text), '')) AS digest FROM ${table} t`);
      return [table, rows[0]];
    })));
    const replayBefore = await snapshot();
    requireSeedResult('receive unavailable fault', await httpCall(`${env.isolatedBusUrl}/__test/broker-receive-unavailable`, {
      method: 'POST', body: { queue: 'g6.pricing.from.bulk', durationMs: 1500 },
    }));
    const replays = [];
    for (const flow of flows) {
      const publication = beforeReplay.evidence.find((event) => event.queue === flow.cola &&
        event.stage === 'PUBLISHED' && event.envelope && beforeReplay.evidence.some((settled) =>
          settled.queue === flow.cola && settled.messageId === event.messageId && settled.stage === 'COMPLETED'));
      if (!publication) throw new Error(`NO_COMPLETED_MESSAGE_FOR_REPLAY ${flow.id}`);
      const completedBefore = beforeReplay.evidence.filter((event) => event.queue === flow.cola &&
        event.messageId === publication.messageId && event.stage === 'COMPLETED').length;
      requireSeedResult(`replay ${flow.id}`, await httpCall(`${env.isolatedBusUrl}/queues/${encodeURIComponent(flow.cola)}/messages`, {
        method: 'POST', body: { body: JSON.stringify(publication.envelope), messageId: publication.messageId,
          correlationId: publication.correlationId, subject: publication.subject, contentType: publication.contentType,
          applicationProperties: publication.applicationProperties },
      }));
      replays.push({ flow: flow.id, queue: flow.cola, messageId: publication.messageId, completedBefore });
    }
    const unavailableEvidence = requireSeedResult('pending during receive outage', await httpCall(`${env.isolatedBusUrl}/__test/broker-evidence`)).json;
    const replayPoll = await pollUntil(() => httpCall(`${env.isolatedBusUrl}/__test/broker-evidence`),
      (r) => replays.every((replay) => r.json?.evidence.filter((event) => event.queue === replay.queue &&
        event.messageId === replay.messageId && event.stage === 'COMPLETED').length > replay.completedBefore));
    const replayAfter = await snapshot();
    const originalPricing = beforeReplay.evidence.find(event => event.queue === 'g6.pricing.from.bulk' &&
      event.stage === 'PUBLISHED' && event.envelope);
    if (!originalPricing) throw new Error('NO_PRICING_COMMAND_FOR_PROCESS_RECOVERY');
    const stopped = requireSeedResult('kill actual Pricing process', await httpCall(`${env.g5SeedOrigin}/__test/pricing-process`, {
      method: 'POST', body: { action: 'stop' },
    })).json;
    const completedBeforeRestart = replayPoll.json.evidence.filter(event => event.queue === originalPricing.queue &&
      event.messageId === originalPricing.messageId && event.stage === 'COMPLETED').length;
    requireSeedResult('publish while Pricing process is stopped', await httpCall(`${env.isolatedBusUrl}/queues/g6.pricing.from.bulk/messages`, {
      method: 'POST', body: { body: JSON.stringify(originalPricing.envelope), messageId: originalPricing.messageId,
        correlationId: originalPricing.correlationId, subject: originalPricing.subject, contentType: originalPricing.contentType,
        applicationProperties: originalPricing.applicationProperties },
    }));
    const whileStopped = requireSeedResult('pending during actual process outage', await httpCall(`${env.isolatedBusUrl}/__test/broker-evidence`)).json;
    const restarted = requireSeedResult('start new actual Pricing process', await httpCall(`${env.g5SeedOrigin}/__test/pricing-process`, {
      method: 'POST', body: { action: 'start' },
    })).json;
    const recovered = await pollUntil(() => httpCall(`${env.isolatedBusUrl}/__test/broker-evidence`), response =>
      response.json.evidence.filter(event => event.queue === originalPricing.queue && event.messageId === originalPricing.messageId &&
        event.stage === 'COMPLETED').length > completedBeforeRestart);
    const processRecovery = { kind: 'ACTUAL_LOCAL_PROCESS_KILL_AND_RESTART', stopped, restarted,
      messageId: originalPricing.messageId, queuedWhileStopped: whileStopped.active['g6.pricing.from.bulk'] >= 1,
      settled: recovered.json.evidence.filter(event => event.queue === originalPricing.queue && event.messageId === originalPricing.messageId &&
        event.stage === 'COMPLETED').length > completedBeforeRestart,
      businessUnchanged: JSON.stringify(replayAfter) === JSON.stringify(await snapshot()),
      limitation: 'Broker remains HTTP in-memory; this does not prove Azure persistence or lock expiry.' };
    const duplicateEvidence = { replays, before: replayBefore, after: replayAfter,
      recovery: { kind: 'LAB_RECEIVE_503_NOT_CONSUMER_PROCESS_STOP', queue: 'g6.pricing.from.bulk',
        queuedWhileUnavailable: unavailableEvidence.active['g6.pricing.from.bulk'] >= 1 },
      allSettled: replays.every((replay) => replayPoll?.json?.evidence.filter((event) => event.queue === replay.queue &&
        event.messageId === replay.messageId && event.stage === 'COMPLETED').length > replay.completedBefore),
      unchanged: JSON.stringify(replayBefore) === JSON.stringify(replayAfter) };
    const invalidId = randomUUID();
    const validCatalogEvent = beforeReplay.evidence.find((event) => event.stage === 'PUBLISHED' && event.queue === 'g6.promotions.from.catalog');
    requireSeedResult('invalid producer injection', await httpCall(`${env.isolatedBusUrl}/queues/g6.promotions.from.catalog/messages`, {
      method: 'POST', body: { body: JSON.stringify({ ...validCatalogEvent.envelope, message_id: invalidId, producer: 'untrusted-producer' }),
        messageId: invalidId, correlationId: randomUUID(), subject: validCatalogEvent.subject, contentType: validCatalogEvent.contentType,
        applicationProperties: { ...validCatalogEvent.applicationProperties, producer: 'untrusted-producer' } },
    }));
    const invalidPoll = await pollUntil(() => httpCall(`${env.isolatedBusUrl}/__test/broker-evidence`),
      (r) => r.json?.evidence.some((event) => event.messageId === invalidId && event.stage === 'DEADLETTERED'));
    const negativeEvidence = { messageId: invalidId, rejected: invalidPoll?.json?.evidence.some((event) =>
      event.messageId === invalidId && event.stage === 'DEADLETTERED'), unchanged: JSON.stringify(replayAfter) === JSON.stringify(await snapshot()) };
    const broker = requireSeedResult("brokerEvidence", await httpCall(`${env.isolatedBusUrl}/__test/broker-evidence`)).json;
    const identifiers = [batchId, admProdId, admSku, catDeactId, n01ConsumeOp, n01RestoreOp];
    for (const flow of flows) {
      const queueEvents = broker.evidence.filter((event) => event.queue === flow.cola);
      const publications = queueEvents.filter((event) => event.stage === "PUBLISHED" &&
        event.envelope?.producer === flow.productor.split("(")[0] &&
        identifiers.some((id) => JSON.stringify(event.envelope).includes(id)));
      flow.messages = publications.map((event) => ({
        messageId: event.messageId, correlationId: event.correlationId,
        name: event.envelope.name, schemaVersion: event.envelope.schema_version,
        publishedAt: event.at,
        received: queueEvents.some((item) => item.stage === "RECEIVED" && item.messageId === event.messageId),
        completed: queueEvents.some((item) => item.stage === "COMPLETED" && item.messageId === event.messageId),
      }));
      flow.chainPass = flow.messages.some((message) => message.received && message.completed);
      flow.invalidMessages = queueEvents.filter((event) => event.stage === "DEADLETTERED" && event.messageId !== invalidId);
      flow.ok = flow.ok && flow.chainPass && flow.invalidMessages.length === 0;
    }
    const passed = flows.filter((f) => f.ok).length;
    const summary = { timestamp: new Date().toISOString(), environment: "local-isolated-service-bus-and-postgres", transport: "HTTP_IN_MEMORY_NOT_AZURE", total: flows.length, passed, failed: flows.length - passed, fixture: { batchId, bulkProdId, bulkSku, admProdId, admSku, comboId, catDeactId, n01Order, n01ConsumeOp, n01RestoreOp }, flows, queryEvidence, duplicateEvidence, processRecovery, negativeEvidence, broker };
    mkdirSync(dirname(REPORT_JSON_PATH), { recursive: true });
    writeFileSync(REPORT_JSON_PATH, JSON.stringify(summary, null, 2), "utf8");
    const csvLines = [
      "flujo,cola,productor,consumidor,estado_laboratorio_aislado,entorno",
      ...flows.map((f) => `${f.id},${f.cola},${f.productor},${f.consumidor},${f.ok ? "PASS" : "FAIL"},local-isolated-sb`),
    ];
    writeFileSync(REPORT_CSV_PATH, csvLines.join("\n"), "utf8");
    console.log(JSON.stringify({ total: flows.length, passed, failed: flows.length - passed }));
    exitCode = passed === flows.length && duplicateEvidence.recovery.queuedWhileUnavailable && duplicateEvidence.allSettled && duplicateEvidence.unchanged &&
      negativeEvidence.rejected && negativeEvidence.unchanged && processRecovery.stopped.stopped && processRecovery.restarted.ready &&
      processRecovery.stopped.pid !== processRecovery.restarted.pid && processRecovery.queuedWhileStopped && processRecovery.settled && processRecovery.businessUnchanged ? 0 : 1;
  } finally {
    writeFileSync(resolve(BACKEND_ROOT, "tests/h5/messaging-stack.log"), stackLogs, "utf8");
    await stopStack();
    process.exitCode = exitCode;
  }
}

void main().catch((err) => {
  console.error(err);
  mkdirSync(dirname(REPORT_JSON_PATH), { recursive: true });
  writeFileSync(REPORT_JSON_PATH, JSON.stringify({ status: "SETUP_FAILED", timestamp: new Date().toISOString(), transport: "HTTP_IN_MEMORY_NOT_AZURE", total: 19, executed: 0, notExecuted: 19, error: err.message }, null, 2));
  process.exit(1);
});
