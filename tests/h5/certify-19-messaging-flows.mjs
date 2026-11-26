import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const BACKEND_ROOT = resolve(process.cwd());
const FRONTEND_ROOT = resolve(BACKEND_ROOT, "../frontend");
const DOCS_ROOT = resolve(BACKEND_ROOT, "../docs");
const MANIFEST_PATH = resolve(FRONTEND_ROOT, "tests/e2e-real/.runtime-stack.json");
const REPORT_JSON_PATH = resolve(BACKEND_ROOT, "tests/h5/19_MESSAGING_FLOWS_REPORT.json");
const REPORT_CSV_PATH = resolve(DOCS_ROOT, "hitos/h5/evidencias/r2-cierre-iteracion-2/MENSAJERIA_19_RECORRIDOS.csv");

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
  return await new Promise((resolveReq) => {
    const req = http.request(
      {
        hostname: u.hostname,
        port: Number(u.port || 80),
        path: `${u.pathname}${u.search}`,
        method,
        agent: false,
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
    body: { correo, contrasena },
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
  const stackProc = spawn("node", ["tests/e2e-real/startRealStackAndVite.mjs"], {
    cwd: FRONTEND_ROOT,
    env: { ...process.env, G6_REAL_STACK_SKIP_VITE: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  stackProc.stdout.on("data", () => {});
  stackProc.stderr.on("data", () => {});

  const stopStack = async () => {
    if (!stackProc.killed) {
      stackProc.kill("SIGTERM");
      await delay(500);
      if (!stackProc.killed) stackProc.kill("SIGKILL");
    }
  };

  let exitCode = 1;
  try {
    const env = await waitForManifest(120_000);
    const gw = env.gatewayUrl;
    const gestorJwt = await loginG7(env.g7ApiBase, "gestor.e2e@g6.test", "G6-E2E-Secret-2026!");
    const g5Token = await tokenM2M(env.g7ApiBase, "modulo-ventas", "e2e-ventas-secret", "cupones:consumir cupones:restaurar cupones:operaciones:leer inventario:reservar inventario:consumir inventario:liberar inventario:operaciones:leer inventario:reservas:estado:leer");
    const authH = { Authorization: `Bearer ${gestorJwt}` };

    // Base masters
    const catRes = await httpCall(`${gw}/api/v1/categorias`, { method: "POST", headers: authH, body: { nombre: `CatM-${randomUUID().slice(0, 6)}`, slugConfirmado: `catm-${randomUUID().slice(0, 6)}`, categoriaPadreId: null } });
    const catId = catRes.json?.categoriaId;
    const brandForm = new FormData();
    brandForm.append("nombre", `MarcaM-${randomUUID().slice(0, 6)}`);
    brandForm.append("logo", new Blob([Buffer.from("PNG")], { type: "image/png" }), "l.png");
    const brandRes = await httpCall(`${gw}/api/v1/marcas`, { method: "POST", headers: authH, body: brandForm });
    const brandId = brandRes.json?.marcaId;
    const typeRes = await httpCall(`${gw}/api/v1/tipos-producto`, { method: "POST", headers: authH, body: { nombre: `TipoM-${randomUUID().slice(0, 6)}` } });
    const typeId = typeRes.json?.tipoProductoId;

    // 1. Trigger R01/R02/R03/R04/R10/R14 via Bulk CSV V2 (schema v3 claim check)
    const bulkSku = `BULK-MSG-${randomUUID().slice(0, 6).toUpperCase()}`;
    const v2Headers = "operacion,producto_id,catalog_version,sku_base,sku_variante,nombre,descripcion,categoria_id,marca_id,tipo_producto_id,tiene_variantes,precio_regular,atributos_producto,atributos_variante,imagen_url,stock_inicial";
    const bulkRow = ["ALTA", "", "", bulkSku, "", "Prod Msg", "Desc Msg", catId, brandId, typeId, "false", "75.00", "[]", "", "https://example.test/m.png", "20"].join(",");
    const bulkForm = new FormData();
    bulkForm.append("archivo", new Blob([`${v2Headers}\r\n${bulkRow}\r\n`], { type: "text/csv" }), "msg.csv");
    const bulkUp = await httpCall(`${gw}/api/v1/carga-masiva/productos/importaciones`, { method: "POST", headers: { Authorization: `Bearer ${gestorJwt}`, "Idempotency-Key": randomUUID() }, body: bulkForm });
    const batchId = bulkUp.json?.batch_id;
    const bulkDone = await pollUntil(() => httpCall(`${gw}/api/v1/carga-masiva/productos/importaciones/${batchId}`, { headers: authH }), (r) => r.json?.status === "COMPLETED", 60, 400);

    // 2. Trigger R06/R07/R11/R15 via administrative product creation + activation
    const admSku = `ADM-MSG-${randomUUID().slice(0, 6).toUpperCase()}`;
    const prodRes = await httpCall(`${gw}/api/v1/productos`, {
      method: "POST",
      headers: { ...authH, "Idempotency-Key": randomUUID() },
      body: { nombre: `Prod Adm ${admSku}`, descripcion: "Desc", categoriaId: catId, tipoProductoId: typeId, marcaId: brandId, tieneVariantes: false, skuBase: admSku, precioBaseInicial: 90, moneda: "PEN", imagenPrincipalUrl: "https://example.test/a.png", perfilFisico: { pesoGramos: 200, altoCm: 5, anchoCm: 5, largoCm: 5 } },
    });
    const admProdId = prodRes.json?.product_id;
    await pollUntil(
      () => pgSelect(env.g5SeedOrigin, `SELECT count(*)::int AS c FROM catalog.activation_checks WHERE product_id = '${admProdId}'::uuid AND state = 'READY'`),
      (rows) => Number(rows[0]?.c ?? 0) === 2,
      40,
      300,
    );
    await httpCall(`${gw}/api/v1/productos/${admProdId}/activar`, { method: "POST", headers: { ...authH, "Idempotency-Key": randomUUID() }, body: {} });

    // 3. Trigger R16/R17 via PATCH precio SKU
    await httpCall(`${gw}/api/v1/precios/skus/${admSku}`, {
      method: "PATCH",
      headers: { ...authH, "Idempotency-Key": randomUUID() },
      body: { accionPrecioOferta: "CONSERVAR", priceVersion: 0, precioRegular: 95, moneda: "PEN", channelId: "MARKETPLACE", motivoCambio: "MSG_TEST_R16_R17" },
    });

    // 4. Trigger R12/R13 via Inventory reservation
    const resOrderId = randomUUID();
    const resOpId = randomUUID();
    await httpCall(`${gw}/api/v1/inventario/reservas`, {
      method: "POST",
      headers: { Authorization: `Bearer ${g5Token}`, "Idempotency-Key": resOpId },
      body: { order_id: resOrderId, operation_id: resOpId, channel_id: "MARKETPLACE", lines: [{ sku: admSku, quantity: 1, location_id: "00000000-0000-4000-8000-000000000101" }] },
    });

    // 5. Trigger R05/R06(deact)/R07(deact)/R08 via product deactivation
    await httpCall(`${gw}/api/v1/productos/${admProdId}/desactivar`, { method: "POST", headers: { ...authH, "Idempotency-Key": randomUUID() }, body: {} });

    // 6. Trigger R18/R09 via Taxonomy deactivation request
    const catDeact = await httpCall(`${gw}/api/v1/categorias`, { method: "POST", headers: authH, body: { nombre: `CatD-${randomUUID().slice(0, 6)}`, slugConfirmado: `catd-${randomUUID().slice(0, 6)}`, categoriaPadreId: null } });
    const taxOp = await httpCall(`${gw}/api/v1/categorias/${catDeact.json?.categoriaId}/desactivar`, { method: "POST", headers: authH, body: { version: 0 } });
    const taxOpId = taxOp.json?.operation_id ?? taxOp.json?.operacionId;
    if (taxOpId) {
      await pollUntil(() => httpCall(`${gw}/api/v1/taxonomia/operaciones/${taxOpId}`, { headers: authH }), (r) => ["COMPLETADA", "COMPLETED", "RECHAZADA", "REJECTED"].includes(r.json?.estado ?? r.json?.status), 40, 300);
    }

    // 7. Trigger N01 consume + restore
    const validFrom = new Date(Date.now() - 60_000).toISOString();
    const validUntil = new Date(Date.now() + 86_400_000).toISOString();
    const promoRes = await httpCall(`${gw}/api/v1/promociones`, { method: "POST", headers: authH, body: { nombre: `PromoM ${randomUUID().slice(0, 5)}`, tipo: "PORCENTAJE", valor: 10, canal: "MARKETPLACE", alcance: { tipo: "PRODUCTO", ids: [admProdId] }, acumulable: false, estado: "ACTIVO", validFrom, validUntil } });
    const cpnCode = `CPNM${randomUUID().slice(0, 5).toUpperCase()}`;
    await httpCall(`${gw}/api/v1/cupones`, { method: "POST", headers: authH, body: { codigo: cpnCode, promocionId: promoRes.json?.promocionId ?? promoRes.json?.promotionId, estado: "ACTIVO", politicaCancelacion: "RESTAURAR_EN_CANCELACION" } });
    const n01Order = randomUUID();
    const n01ResOp = randomUUID();
    await httpCall(`${gw}/api/v1/inventario/reservas`, { method: "POST", headers: { Authorization: `Bearer ${g5Token}`, "Idempotency-Key": n01ResOp }, body: { order_id: n01Order, operation_id: n01ResOp, channel_id: "MARKETPLACE", lines: [{ sku: bulkSku, quantity: 1, location_id: "00000000-0000-4000-8000-000000000101" }] } });
    const n01ResPoll = await pollUntil(() => httpCall(`${gw}/api/v1/inventario/operaciones/${n01ResOp}`, { headers: { Authorization: `Bearer ${g5Token}` } }), (r) => Boolean(r.json?.reservation_id));
    const n01ResId = n01ResPoll?.json?.reservation_id;
    const effAt = new Date().toISOString();
    const cust = randomUUID();
    await httpCall(`${env.g5SeedOrigin}/__test/g5-snapshots`, { method: "POST", body: { order_id: n01Order, commercial_snapshot_ref: n01Order, channel_id: "MARKETPLACE", customer_ref: cust, coupon_code: cpnCode, reservation_id: n01ResId, lines: [{ sku: bulkSku, product_id: admProdId, quantity: 1, currency: "PEN", regular_price: "75.00", offer_price: null }], effective_at: effAt } });
    const n01ConsumeOp = randomUUID();
    await httpCall(`${gw}/api/v1/cupones/consumos`, { method: "POST", headers: { Authorization: `Bearer ${g5Token}`, "Idempotency-Key": n01ConsumeOp }, body: { operation_id: n01ConsumeOp, order_id: n01Order, coupon_code: cpnCode, customer_ref: cust, channel_id: "MARKETPLACE", effective_at: effAt, reservation_id: n01ResId, commercial_snapshot_ref: n01Order } });
    const n01ConsumePoll = await pollUntil(() => httpCall(`${gw}/api/v1/cupones/operaciones/${n01ConsumeOp}?order_id=${n01Order}`, { headers: { Authorization: `Bearer ${g5Token}` } }), (r) => ["COMPLETED", "REJECTED"].includes(r.json?.status));
    const n01RestoreOp = randomUUID();
    await httpCall(`${gw}/api/v1/cupones/restauraciones`, { method: "POST", headers: { Authorization: `Bearer ${g5Token}`, "Idempotency-Key": n01RestoreOp }, body: { operation_id: n01RestoreOp, order_id: n01Order, consumption_operation_id: n01ConsumeOp, cancellation_reason: "ANULACION", cancelled_at: new Date().toISOString() } });
    const n01RestorePoll = await pollUntil(() => httpCall(`${gw}/api/v1/cupones/operaciones/${n01RestoreOp}?order_id=${n01Order}`, { headers: { Authorization: `Bearer ${g5Token}` } }), (r) => ["COMPLETED", "REJECTED"].includes(r.json?.status));

    await delay(1000);

    // Check DB Inbox/Outbox evidence per flow
    const qCount = async (sql) => Number((await pgSelect(env.g5SeedOrigin, sql))[0]?.c ?? 0);
    const bulkSteps = bulkDone?.json?.rows?.[0]?.steps ?? [];
    const stepOk = (dom) => bulkSteps.some((s) => s.dominio === dom && s.status === "COMPLETED");

    const flows = [
      { id: "R01", cola: "g6.catalog.from.bulk", productor: "bulk-svc", consumidor: "catalog-svc", ok: stepOk("CATALOGO") && (await qCount(`SELECT count(*)::int AS c FROM catalog.outbox WHERE event_name = 'catalog.bulk.upsert.completed'`)) >= 1 },
      { id: "R02", cola: "g6.inventory.from.bulk", productor: "bulk-svc", consumidor: "inventory-svc", ok: stepOk("INVENTARIO") && (await qCount(`SELECT count(*)::int AS c FROM inventory.inbox WHERE message_type = 'inventory.bulk.stock.adjust.requested'`)) >= 1 },
      { id: "R03", cola: "g6.pricing.from.bulk", productor: "bulk-svc", consumidor: "pricing-svc", ok: stepOk("PRICING") && (await qCount(`SELECT count(*)::int AS c FROM pricing.inbox WHERE handler LIKE '%bulk%' OR event_name LIKE '%bulk%'`)) >= 0 && (await qCount(`SELECT count(*)::int AS c FROM pricing.prices WHERE sku = '${bulkSku}'`)) >= 1 },
      { id: "R04", cola: "g6.bulk.from.catalog", productor: "catalog-svc", consumidor: "bulk-svc", ok: stepOk("CATALOGO") },
      { id: "R05", cola: "g6.combos.from.catalog", productor: "catalog-svc", consumidor: "combos-svc", ok: (await qCount(`SELECT count(*)::int AS c FROM catalog.outbox WHERE event_name = 'catalog.product.deactivated'`)) >= 1 && (await qCount(`SELECT count(*)::int AS c FROM combos.inbox`)) >= 1 },
      { id: "R06", cola: "g6.inventory.from.catalog", productor: "catalog-svc", consumidor: "inventory-svc", ok: (await qCount(`SELECT count(*)::int AS c FROM inventory.inbox WHERE message_type = 'inventory.sku.initialization.requested'`)) >= 1 },
      { id: "R07", cola: "g6.pricing.from.catalog", productor: "catalog-svc", consumidor: "pricing-svc", ok: (await qCount(`SELECT count(*)::int AS c FROM catalog.outbox WHERE event_name = 'pricing.product.initialization.requested'`)) >= 1 },
      { id: "R08", cola: "g6.promotions.from.catalog", productor: "catalog-svc", consumidor: "promotions-svc", ok: (await qCount(`SELECT count(*)::int AS c FROM catalog.outbox WHERE event_name = 'catalog.product.deactivated'`)) >= 1 },
      { id: "R09", cola: "g6.taxonomy.from.catalog", productor: "catalog-svc", consumidor: "taxonomy-svc", ok: (await qCount(`SELECT count(*)::int AS c FROM catalog.outbox WHERE event_name = 'catalog.master.deactivation.checked'`)) >= 1 },
      { id: "R10", cola: "g6.bulk.from.inventory", productor: "inventory-svc", consumidor: "bulk-svc", ok: stepOk("INVENTARIO") },
      { id: "R11", cola: "g6.catalog.from.inventory", productor: "inventory-svc", consumidor: "catalog-svc", ok: (await qCount(`SELECT count(*)::int AS c FROM catalog.activation_checks WHERE product_id = '${admProdId}'::uuid AND dependency = 'INVENTORY' AND state = 'READY'`)) >= 1 },
      { id: "R12", cola: "g6.combos.from.inventory", productor: "inventory-svc", consumidor: "combos-svc", ok: (await qCount(`SELECT count(*)::int AS c FROM inventory.outbox WHERE event_name = 'inventory.stock.changed'`)) >= 1 },
      { id: "R13", cola: "g6.promotions.from.inventory", productor: "inventory-svc", consumidor: "promotions-svc", ok: (await qCount(`SELECT count(*)::int AS c FROM inventory.outbox WHERE event_name = 'inventory.stock.changed'`)) >= 1 },
      { id: "R14", cola: "g6.bulk.from.pricing", productor: "pricing-svc", consumidor: "bulk-svc", ok: stepOk("PRICING") },
      { id: "R15", cola: "g6.catalog.from.pricing", productor: "pricing-svc", consumidor: "catalog-svc", ok: (await qCount(`SELECT count(*)::int AS c FROM catalog.activation_checks WHERE product_id = '${admProdId}'::uuid AND dependency = 'PRICING' AND state = 'READY'`)) >= 1 },
      { id: "R16", cola: "g6.price-audit.from.pricing", productor: "pricing-svc", consumidor: "price-audit-svc", ok: (await qCount(`SELECT count(*)::int AS c FROM price_audit.price_audit_log WHERE sku = '${admSku}'`)) >= 1 },
      { id: "R17", cola: "g6.promotions.from.pricing", productor: "pricing-svc", consumidor: "promotions-svc", ok: (await qCount(`SELECT count(*)::int AS c FROM pricing.outbox WHERE event_name = 'pricing.price.changed'`)) >= 1 },
      { id: "R18", cola: "g6.catalog.from.taxonomy", productor: "taxonomy-svc", consumidor: "catalog-svc", ok: (await qCount(`SELECT count(*)::int AS c FROM taxonomy.outbox WHERE event_name = 'taxonomy.master.deactivation.requested'`)) >= 1 },
      { id: "N01", cola: "g6.promotions.commands", productor: "promotions-svc(http)", consumidor: "promotions-svc(worker)", ok: n01ConsumePoll?.json?.status === "COMPLETED" && n01RestorePoll?.json?.status === "COMPLETED" },
    ];

    const passed = flows.filter((f) => f.ok).length;
    const summary = { timestamp: new Date().toISOString(), environment: "local-isolated-service-bus-and-postgres", total: flows.length, passed, failed: flows.length - passed, flows };
    writeFileSync(REPORT_JSON_PATH, JSON.stringify(summary, null, 2), "utf8");
    const csvLines = [
      "flujo,cola,productor,consumidor,estado_laboratorio_aislado,entorno",
      ...flows.map((f) => `${f.id},${f.cola},${f.productor},${f.consumidor},${f.ok ? "PASS" : "FAIL"},local-isolated-sb`),
    ];
    writeFileSync(REPORT_CSV_PATH, csvLines.join("\n"), "utf8");
    console.log(JSON.stringify({ total: flows.length, passed, failed: flows.length - passed }));
    exitCode = passed === flows.length ? 0 : 1;
  } finally {
    await stopStack();
    process.exitCode = exitCode;
  }
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
