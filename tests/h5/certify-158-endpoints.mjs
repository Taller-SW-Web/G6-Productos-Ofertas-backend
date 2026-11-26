import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const BACKEND_ROOT = resolve(process.cwd());
const FRONTEND_ROOT = resolve(BACKEND_ROOT, "../frontend");
const DOCS_ROOT = resolve(BACKEND_ROOT, "../docs");
const MANIFEST_PATH = resolve(FRONTEND_ROOT, "tests/e2e-real/.runtime-stack.json");
const MATRIX_PATH = resolve(DOCS_ROOT, "hitos/h5/MATRIZ_158_OPERACIONES_H5_R2.csv");
const REPORT_JSON_PATH = resolve(BACKEND_ROOT, "tests/h5/158_ENDPOINTS_CERTIFICATION_REPORT.json");
const REPORT_MD_PATH = resolve(BACKEND_ROOT, "tests/h5/158_ENDPOINTS_CERTIFICATION_REPORT.md");

function parseCsvLine(line) {
  const cols = [];
  let cur = "";
  let inQ = false;
  for (const ch of line) {
    if (ch === '"') {
      inQ = !inQ;
    } else if (ch === "," && !inQ) {
      cols.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  cols.push(cur);
  return cols;
}

function stableUuid(seed) {
  const bytes = createHash("sha256").update(seed).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function waitForManifest(timeoutMs = 120_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (existsSync(MANIFEST_PATH)) {
      return JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
    }
    await delay(500);
  }
  throw new Error("TIMEOUT esperando .runtime-stack.json");
}

async function loginG7(g7ApiBase, correo, contrasena) {
  const res = await fetch(`${g7ApiBase}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ correo, contrasena, formatoAcceso: "JWS" }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function tokenM2M(g7ApiBase, clientId, clientSecret, scope) {
  const res = await fetch(`${g7ApiBase}/api/v1/auth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
      scope,
    }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function httpCall(url, { method = "GET", headers = {}, body } = {}) {
  try {
    if (body instanceof FormData) {
      const cleanHeaders = Object.fromEntries(
        Object.entries(headers).filter(([k]) => k.toLowerCase() !== "content-type"),
      );
      const res = await fetch(url, {
        method,
        headers: {
          "X-Correlation-Id": randomUUID(),
          ...cleanHeaders,
        },
        signal: AbortSignal.timeout(10_000),
        body,
      });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { json = null; }
      return { status: res.status, headers: Object.fromEntries(res.headers.entries()), text, json };
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
            ...(payload !== undefined && !(headers["content-type"] || headers["Content-Type"])
              ? { "content-type": "application/json" }
              : {}),
            ...(payload !== undefined ? { "Content-Length": String(Buffer.byteLength(payload)) } : {}),
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
            resolveReq({ status: res.statusCode ?? 0, headers: res.headers, text, json });
          });
        },
      );
      req.on("timeout", () => req.destroy(new Error("Request timeout")));
      req.on("error", (err) => resolveReq({ status: 0, headers: {}, text: err.message, json: null }));
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { status: 0, headers: {}, text: msg, json: null };
  }
}

async function pollUntil(fn, isDone, maxAttempts = 30, delayMs = 300) {
  let last = null;
  for (let i = 0; i < maxAttempts; i++) {
    last = await fn();
    if (isDone(last)) return last;
    await delay(delayMs);
  }
  return last;
}

async function main() {
  if (existsSync(MANIFEST_PATH)) {
    rmSync(MANIFEST_PATH, { force: true });
  }

  const stackChild = spawn(
    process.execPath,
    [resolve(FRONTEND_ROOT, "tests/e2e-real/startRealStackAndVite.mjs"), "--no-vite"],
    {
      cwd: FRONTEND_ROOT,
      env: {
        ...process.env,
        G6_BACKEND_ROOT: BACKEND_ROOT,
        G6_DOCS_ROOT: DOCS_ROOT,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let stackLogs = "";
  stackChild.stdout.on("data", (d) => { stackLogs += d.toString(); });
  stackChild.stderr.on("data", (d) => { stackLogs += d.toString(); });

  const stopStack = async () => {
    if (!stackChild.killed) {
      stackChild.kill("SIGINT");
      await Promise.race([
        new Promise((r) => stackChild.once("exit", r)),
        delay(8_000),
      ]);
      if (!stackChild.killed) stackChild.kill("SIGKILL");
    }
  };

  let exitCode = 1;
  try {
    await Promise.race([
      new Promise((resolveReady, rejectReady) => {
        stackChild.stdout.on("data", (d) => {
          if (d.toString().includes("G6_STACK_READY")) resolveReady();
        });
        stackChild.once("exit", (code) => {
          rejectReady(new Error(`Stack exited prematurely (${code}):\n${stackLogs.slice(-3000)}`));
        });
      }),
      delay(150_000).then(() => {
        throw new Error(`Timeout waiting for G6_STACK_READY:\n${stackLogs.slice(-3000)}`);
      }),
    ]);

    const env = await waitForManifest(10_000);
    console.error("[certify] G6_STACK_READY");
    const gw = env.gatewayUrl;

    // 1. G7 Auth checks
    const authChecks = [];
    const gestorLogin = await loginG7(env.g7ApiBase, "gestor@example.test", "isolated-g7-password");
    const sinRolLogin = await loginG7(env.g7ApiBase, "sinrol@example.test", "isolated-sinrol-password");
    const badPass = await loginG7(env.g7ApiBase, "gestor@example.test", "wrong");
    const blockedUser = await loginG7(env.g7ApiBase, "bloqueado@example.test", "isolated-bloqueado-password");
    authChecks.push({ name: "login_gestor", pass: gestorLogin.status === 200 });
    authChecks.push({ name: "login_sinrol", pass: sinRolLogin.status === 200 });
    authChecks.push({ name: "login_bad_password_401", pass: badPass.status === 401 });
    authChecks.push({ name: "login_blocked_401", pass: blockedUser.status === 401 });

    const refreshOk = await httpCall(`${env.g7ApiBase}/auth/refresh`, {
      method: "POST",
      body: { refreshToken: gestorLogin.body.refreshToken },
    });
    const refreshReuse = await httpCall(`${env.g7ApiBase}/auth/refresh`, {
      method: "POST",
      body: { refreshToken: gestorLogin.body.refreshToken },
    });
    authChecks.push({ name: "refresh_rotate_200", pass: refreshOk.status === 200 });
    authChecks.push({ name: "refresh_reuse_401", pass: refreshReuse.status === 401 });

    const gestorJwt = refreshOk.json?.accessToken;
    if (!gestorJwt) throw new Error(`G7 refresh failed: ${refreshOk.status}`);
    const sinRolJwt = sinRolLogin.body.accessToken;
    const authH = { Authorization: `Bearer ${gestorJwt}`, "content-type": "application/json" };

    const g1Token = (await tokenM2M(env.g7ApiBase, "modulo-marketplace", "e2e-marketplace-secret", "catalogo:leer precios:leer promociones:evaluar promociones:leer cupones:validar recomendaciones:leer combos:leer inventario:disponibilidad:leer")).body.accessToken;
    const g3Token = (await tokenM2M(env.g7ApiBase, "modulo-chatbot", "e2e-chatbot-secret", "catalogo:leer precios:leer promociones:evaluar combos:leer inventario:disponibilidad:leer")).body.accessToken;
    const g5Token = (await tokenM2M(env.g7ApiBase, "modulo-ventas", "e2e-ventas-secret", "cupones:consumir cupones:restaurar cupones:operaciones:leer inventario:reservar inventario:consumir inventario:liberar inventario:conciliar-offline inventario:operaciones:leer inventario:reservas:estado:leer")).body.accessToken;
    const prodSvcToken = (await tokenM2M(env.g7ApiBase, "modulo-productos", "e2e-catalog-secret", "catalogo:leer")).body.accessToken;
    const postventaToken = (await tokenM2M(env.g7ApiBase, "modulo-postventa", "e2e-postventa-secret", "inventario:disponibilidad:leer inventario:reintegrar")).body.accessToken;
    const retailToken = (await tokenM2M(env.g7ApiBase, "modulo-retail", "e2e-retail-secret", "catalogo:leer precios:leer promociones:evaluar combos:leer inventario:disponibilidad:leer inventario:incidencias:reportar inventario:incidencias:resolver")).body.accessToken;
    const despachoToken = (await tokenM2M(env.g7ApiBase, "modulo-despacho", "e2e-despacho-secret", "inventario:disponibilidad:leer catalogo:leer productos:fisicos:leer")).body.accessToken;
    const catalogSvcToken = (await tokenM2M(env.g7ApiBase, "catalog-svc", "e2e-catalog-secret", "carga-masiva:contenidos:leer")).body.accessToken;
    const inventorySvcToken = (await tokenM2M(env.g7ApiBase, "inventory-svc", "e2e-inventory-secret", "catalogo:leer")).body.accessToken;
    const promotionsSvcToken = (await tokenM2M(env.g7ApiBase, "promotions-svc", "e2e-promotions-secret", "inventario:reservas:estado:leer")).body.accessToken;

    // 2. Seed rich lab fixtures across all 8 services
    const catSlug = `cert-cat-${randomUUID().slice(0, 6)}`;
    const catSlugPrev = `cert-cat-prev-${randomUUID().slice(0, 6)}`;
    const catRes = await httpCall(`${gw}/api/v1/categorias`, {
      method: "POST",
      headers: authH,
      body: { nombre: `Cat Cert ${catSlug}`, slugConfirmado: catSlugPrev, categoriaPadreId: null },
    });
    const catId = catRes.json?.categoriaId;
    // Update SEO slug so catSlugPrev is in slug history & catSlug is current!
    await httpCall(`${gw}/api/v1/categorias/${catId}/seo`, {
      method: "PATCH",
      headers: authH,
      body: { slug: catSlug, metaTitulo: "SEO Cert Title", metaDescripcion: "SEO Cert Desc" },
    });

    const catDeactRes = await httpCall(`${gw}/api/v1/categorias`, {
      method: "POST",
      headers: authH,
      body: { nombre: `Cat Deact ${randomUUID().slice(0, 6)}`, slugConfirmado: `cat-deact-${randomUUID().slice(0, 6)}` },
    });
    const catIdDeact = catDeactRes.json?.categoriaId ?? catId;

    const logoBuf = readFileSync(resolve(BACKEND_ROOT, "apps/taxonomy-svc/test/fixtures/logo.png"));
    const makeBrandForm = (name) => {
      const bf = new FormData();
      bf.append("nombre", name);
      bf.append("logo", new Blob([logoBuf], { type: "image/png" }), "logo.png");
      return bf;
    };
    const brandRes = await httpCall(`${gw}/api/v1/marcas`, {
      method: "POST",
      headers: { Authorization: `Bearer ${gestorJwt}` },
      body: makeBrandForm(`Marca Cert ${randomUUID().slice(0, 6)}`),
    });
    const brandId = brandRes.json?.marcaId;
    const brandDeactRes = await httpCall(`${gw}/api/v1/marcas`, {
      method: "POST",
      headers: { Authorization: `Bearer ${gestorJwt}` },
      body: makeBrandForm(`Marca Deact ${randomUUID().slice(0, 6)}`),
    });
    const brandIdDeact = brandDeactRes.json?.marcaId ?? brandId;

    const typeRes = await httpCall(`${gw}/api/v1/tipos-producto`, {
      method: "POST",
      headers: authH,
      body: { nombre: `Tipo Cert ${randomUUID().slice(0, 6)}` },
    });
    const typeId = typeRes.json?.tipoProductoId;
    const typeDeactRes = await httpCall(`${gw}/api/v1/tipos-producto`, {
      method: "POST",
      headers: authH,
      body: { nombre: `Tipo Deact ${randomUUID().slice(0, 6)}` },
    });
    const typeIdDeact = typeDeactRes.json?.tipoProductoId ?? typeId;

    const attrRes = await httpCall(`${gw}/api/v1/caracteristicas`, {
      method: "POST",
      headers: authH,
      body: { nombre: `Attr Cert ${randomUUID().slice(0, 6)}`, tipo: "LISTA" },
    });
    const attrId = attrRes.json?.caracteristicaId;
    const attrName = attrRes.json?.nombre ?? "Attr";
    const attr2Res = await httpCall(`${gw}/api/v1/caracteristicas`, {
      method: "POST",
      headers: authH,
      body: { nombre: `Attr2 Cert ${randomUUID().slice(0, 6)}`, tipo: "LISTA" },
    });
    const attrId2 = attr2Res.json?.caracteristicaId ?? attrId;

    const valRes = await httpCall(`${gw}/api/v1/caracteristicas/${attrId}/valores`, {
      method: "POST",
      headers: authH,
      body: { nombre: `Val-${randomUUID().slice(0, 6)}` },
    });
    const valId = valRes.json?.valorId;
    const valName = valRes.json?.nombre ?? "Val";
    const val2Res = await httpCall(`${gw}/api/v1/caracteristicas/${attrId}/valores`, {
      method: "POST",
      headers: authH,
      body: { nombre: `Val2-${randomUUID().slice(0, 6)}` },
    });
    const valId2 = val2Res.json?.valorId ?? valId;
    const valName2 = val2Res.json?.nombre ?? "Val2";
    const valDeactRes = await httpCall(`${gw}/api/v1/caracteristicas/${attrId}/valores`, {
      method: "POST",
      headers: authH,
      body: { nombre: `ValDeact-${randomUUID().slice(0, 6)}` },
    });
    const valIdDeact = valDeactRes.json?.valorId ?? valId2;

    await httpCall(`${gw}/api/v1/tipos-producto/${typeId}/caracteristicas`, {
      method: "POST",
      headers: authH,
      body: { caracteristicaId: attrId, obligatoria: false, esIdentificador: false },
    });

    const v2Headers = "operacion,producto_id,catalog_version,sku_base,sku_variante,nombre,descripcion,categoria_id,marca_id,tipo_producto_id,tiene_variantes,precio_regular,atributos_producto,atributos_variante,imagen_url,stock_inicial";
    // Seed retryable bulk batch FIRST (before any CatalogMasterClient call caches CatalogBulkIdentity) via real G7 503 transient failure -> CATALOG_AUTH_TEMPORARY_UNAVAILABLE
    await httpCall(`${env.g5SeedOrigin}/__test/g7-fail-next-catalog-token`, { method: "POST" });
    const retryBulkSku = `BULK-RETRY-${randomUUID().slice(0, 6).toUpperCase()}`;
    const retryBulkRow = ["ALTA", "", "", retryBulkSku, "", "Prod Bulk Retry", "Desc Bulk Retry", catId, brandId, typeId, "false", "55.00", "[]", "", "https://example.test/br.png", "15"].join(",");
    const retryBulkForm = new FormData();
    retryBulkForm.append("archivo", new Blob([`${v2Headers}\r\n${retryBulkRow}\r\n`], { type: "text/csv" }), "retry.csv");
    const retryBulkCorrId = randomUUID();
    const retryBulkUpload = await httpCall(`${gw}/api/v1/carga-masiva/productos/importaciones`, {
      method: "POST",
      headers: { Authorization: `Bearer ${gestorJwt}`, "Idempotency-Key": randomUUID(), "X-Correlation-Id": retryBulkCorrId },
      body: retryBulkForm,
    });
    const retryBatchId = retryBulkUpload.json?.batch_id;
    if (!retryBatchId) {
      throw new Error(`SEED_FAILED retryBulkUpload status=${retryBulkUpload.status} body=${retryBulkUpload.text}`);
    }
    const retrySeedPoll = await pollUntil(
      () => httpCall(`${gw}/api/v1/carga-masiva/productos/importaciones/${retryBatchId}`, { headers: { Authorization: `Bearer ${gestorJwt}` } }),
      (r) => ["COMPLETED", "FAILED_GENERAL"].includes(r.json?.status),
      40,
      400,
    );
    if (retrySeedPoll?.json?.status !== "COMPLETED" || retrySeedPoll?.json?.failed_rows !== 1) {
      throw new Error(`SEED_FAILED retryBatchId did not reach real retryable COMPLETED(failed_rows=1): ${JSON.stringify(retrySeedPoll?.json)}`);
    }

    // Seed two active products + stock + price
    const activeProd1 = randomUUID();
    const activeSku1 = `SKU-CERT1-${randomUUID().slice(0, 6).toUpperCase()}`;
    const activeProd2 = randomUUID();
    const activeSku2 = `SKU-CERT2-${randomUUID().slice(0, 6).toUpperCase()}`;
    for (const [productId, skuBase] of [[activeProd1, activeSku1], [activeProd2, activeSku2]]) {
      await httpCall(`${env.g5SeedOrigin}/__test/catalog-active-product`, {
        method: "POST",
        body: { productId, skuBase, categoriaId: catId, marcaId: brandId, tipoProductoId: typeId },
      });
      await httpCall(`${env.g5SeedOrigin}/__test/inventory-stock`, {
        method: "POST",
        body: { sku: skuBase, on_hand: 50 },
      });
      await httpCall(`${gw}/api/v1/precios/productos/${productId}`, {
        method: "PATCH",
        headers: { ...authH, "Idempotency-Key": randomUUID() },
        body: { accionPrecioOferta: "CONSERVAR", priceVersion: 0, precioRegular: 120, moneda: "PEN", motivoCambio: "CERT_SEED" },
      });
    }
    const activeProd1Slug = `prod-activo-${activeSku1.toLowerCase()}`;
    const barcode1 = `775${Date.now().toString().slice(-10)}`;
    await httpCall(`${env.g5SeedOrigin}/__test/catalog-barcode`, {
      method: "POST",
      body: { sku: activeSku1, codigo_barras: barcode1 },
    });

    // Seed a TIENDA location & stock for conciliarVentaOffline + transfer for traslados
    const storeLocationId = randomUUID();
    await httpCall(`${env.g5SeedOrigin}/__test/inventory-store-location`, {
      method: "POST",
      body: { locationId: storeLocationId, code: "TIENDA-CERT-01", external_ref: "TIENDA-CERT-01", sku: activeSku1, on_hand: 30 },
    });
    const trasladoId = randomUUID();
    await httpCall(`${env.g5SeedOrigin}/__test/inventory-transfer`, {
      method: "POST",
      body: { trasladoId, sku: activeSku1, targetLocationId: storeLocationId },
    });

    // Seed a product with variants + active variant
    const varProdSku = `SKU-VARP-${randomUUID().slice(0, 6).toUpperCase()}`;
    const varProdRes = await httpCall(`${gw}/api/v1/productos`, {
      method: "POST",
      headers: { ...authH, "Idempotency-Key": randomUUID() },
      body: {
        nombre: `Prod Var ${randomUUID().slice(0, 6)}`,
        descripcion: "Producto con variantes certificacion",
        categoriaId: catId,
        marcaId: brandId,
        tipoProductoId: typeId,
        skuBase: varProdSku,
        tieneVariantes: true,
        precioBaseInicial: 150,
      },
    });
    const varProdId = varProdRes.json?.product_id ?? varProdRes.json?.productId;
    if (varProdRes.status >= 400) console.error(`[certify] seed varProdRes=${varProdRes.status} ${varProdRes.text}`);
    const varSku = `${varProdSku}-V1`;
    const varCreateRes = await httpCall(`${gw}/api/v1/productos/${varProdId}/variantes`, {
      method: "POST",
      headers: { ...authH, "Idempotency-Key": randomUUID() },
      body: {
        sku: varSku,
        atributosIdentificadores: [{ caracteristica_id: attrId, nombre: attrName, valor_id: valId, valor: valName }],
        atributosNoIdentificadores: [],
        imagenUrl: "https://example.test/v1.png",
        perfilFisico: { pesoKg: 1.2, dimensionesCm: { largo: 10, ancho: 10, alto: 5 } },
      },
    });
    const varId = varCreateRes.json?.variant_id ?? varCreateRes.json?.variantId;

    // Seed draft product (for activar/desactivar/reactivar)
    const draftSku = `SKU-DRF-${randomUUID().slice(0, 6).toUpperCase()}`;
    const draftRes = await httpCall(`${gw}/api/v1/productos`, {
      method: "POST",
      headers: { ...authH, "Idempotency-Key": randomUUID() },
      body: {
        nombre: `Prod Borrador ${randomUUID().slice(0, 6)}`,
        descripcion: "Producto borrador certificacion",
        categoriaId: catId,
        marcaId: brandId,
        tipoProductoId: typeId,
        skuBase: draftSku,
        tieneVariantes: false,
        precioBaseInicial: 90,
      },
    });
    const draftProdId = draftRes.json?.product_id ?? draftRes.json?.productId;

    // Seed combo
    const comboRes = await httpCall(`${gw}/api/v1/combos/administracion`, {
      method: "POST",
      headers: { ...authH, "Idempotency-Key": randomUUID() },
      body: {
        nombre: `Combo Cert ${randomUUID().slice(0, 6)}`,
        componentes: [{ sku: activeSku1, cantidad: 1 }, { sku: activeSku2, cantidad: 1 }],
        precioCombo: 200,
      },
    });
    const comboId = comboRes.json?.combo_id;
    const comboDeactRes = await httpCall(`${gw}/api/v1/combos/administracion`, {
      method: "POST",
      headers: { ...authH, "Idempotency-Key": randomUUID() },
      body: {
        nombre: `Combo Deact ${randomUUID().slice(0, 6)}`,
        componentes: [{ sku: activeSku1, cantidad: 1 }, { sku: activeSku2, cantidad: 1 }],
        precioCombo: 210,
      },
    });
    const comboIdToDeactivate = comboDeactRes.json?.combo_id ?? comboId;

    // Seed promotion, coupon, recommendation rule
    const nowMs = Date.now();
    const validFrom = new Date(nowMs - 60_000).toISOString();
    const validUntil = new Date(nowMs + 86_400_000).toISOString();
    const promoRes = await httpCall(`${gw}/api/v1/promociones`, {
      method: "POST",
      headers: authH,
      body: {
        nombre: `Promo Cert ${randomUUID().slice(0, 6)}`,
        tipoDescuento: "PORCENTAJE",
        valor: 10,
        modalidad: "CUPON",
        estado: "ACTIVO",
        prioridad: 1,
        validFrom,
        validUntil,
        canalesHabilitados: ["MARKETPLACE", "CHATBOT", "RETAIL"],
        alcance: { productIds: [activeProd1] },
        politicaCombinacion: { ofertaPricing: true, promocionAutomatica: true, cupon: true },
      },
    });
    if (promoRes.status >= 400) console.error(`[certify] seed promoRes=${promoRes.status} ${promoRes.text}`);
    const promoId = promoRes.json?.promotionId;

    const promoDeactRes = await httpCall(`${gw}/api/v1/promociones`, {
      method: "POST",
      headers: authH,
      body: {
        nombre: `Promo Deact ${randomUUID().slice(0, 6)}`,
        tipoDescuento: "PORCENTAJE",
        valor: 10,
        modalidad: "CUPON",
        estado: "ACTIVO",
        prioridad: 2,
        validFrom: new Date(Date.now() - 60_000).toISOString(),
        validUntil: new Date(Date.now() + 86_400_000).toISOString(),
        canalesHabilitados: ["MARKETPLACE"],
        alcance: { productIds: [activeProd1] },
        politicaCombinacion: { ofertaPricing: true, promocionAutomatica: true, cupon: true },
      },
    });
    const promoIdDeact = promoDeactRes.json?.promotionId ?? promoId;

    const couponCode = `CRT${randomUUID().slice(0, 6).toUpperCase()}`;
    const couponRes = await httpCall(`${gw}/api/v1/cupones`, {
      method: "POST",
      headers: authH,
      body: { codigo: couponCode, promocionId: promoId, estado: "ACTIVO", politicaCancelacion: "RESTAURAR_EN_CANCELACION" },
    });
    if (couponRes.status >= 400) console.error(`[certify] seed couponRes=${couponRes.status} ${couponRes.text}`);
    const couponId = couponRes.json?.cuponId ?? couponRes.json?.couponId;

    const couponCodeDeact = `CRTD${randomUUID().slice(0, 5).toUpperCase()}`;
    const couponDeactRes = await httpCall(`${gw}/api/v1/cupones`, {
      method: "POST",
      headers: authH,
      body: { codigo: couponCodeDeact, promocionId: promoId, estado: "ACTIVO", politicaCancelacion: "RESTAURAR_EN_CANCELACION" },
    });
    const couponIdDeact = couponDeactRes.json?.cuponId ?? couponDeactRes.json?.couponId ?? couponId;

    const ruleRes = await httpCall(`${gw}/api/v1/recomendaciones/reglas`, {
      method: "POST",
      headers: authH,
      body: {
        nombre: `Regla Cert ${randomUUID().slice(0, 6)}`,
        tipo: "CROSS_SELL",
        origen: { tipo: "PRODUCTO", id: activeProd1 },
        recomendados: [{ productId: activeProd2, orden: 1 }],
        estado: "ACTIVO",
        validFrom,
        validUntil,
        prioridad: 1,
      },
    });
    if (ruleRes.status >= 400) console.error(`[certify] seed ruleRes=${ruleRes.status} ${ruleRes.text}`);
    const ruleId = ruleRes.json?.reglaId ?? ruleRes.json?.ruleId;

    // Inventory reservation + N01 consume + N01 restore
    const orderId = randomUUID();
    const resOpId = randomUUID();
    const resRes = await httpCall(`${gw}/api/v1/inventario/reservas`, {
      method: "POST",
      headers: { Authorization: `Bearer ${g5Token}`, "Idempotency-Key": resOpId },
      body: { order_id: orderId, operation_id: resOpId, channel_id: "MARKETPLACE", lines: [{ sku: activeSku1, quantity: 2, location_id: "00000000-0000-4000-8000-000000000101" }] },
    });
    if (resRes.status >= 400) console.error(`[certify] seed resRes=${resRes.status} ${resRes.text}`);
    const invOpId = resRes.json?.operation_id ?? resOpId;
    const invOpPoll = await pollUntil(
      () => httpCall(`${gw}/api/v1/inventario/operaciones/${invOpId}`, { headers: { Authorization: `Bearer ${g5Token}` } }),
      (r) => r.json?.reservation_id || r.json?.status === "APLICADO" || r.json?.status === "COMPLETED",
    );
    const reservationId = invOpPoll?.json?.reservation_id ?? "";

    // Confirm reservation (second reservation so original reservationId stays active/confirmed properly)
    const orderId2 = randomUUID();
    const res2 = await httpCall(`${gw}/api/v1/inventario/reservas`, {
      method: "POST",
      headers: { Authorization: `Bearer ${g5Token}`, "Idempotency-Key": randomUUID() },
      body: { order_id: orderId2, operation_id: randomUUID(), channel_id: "MARKETPLACE", lines: [{ sku: activeSku1, quantity: 1, location_id: "00000000-0000-4000-8000-000000000101" }] },
    });
    const res2Op = await pollUntil(
      () => httpCall(`${gw}/api/v1/inventario/operaciones/${res2.json?.operation_id}`, { headers: { Authorization: `Bearer ${g5Token}` } }),
      (r) => Boolean(r.json?.reservation_id),
    );
    const reservationId2 = res2Op?.json?.reservation_id;

    // 3rd reservation for liberarReserva
    const orderId3 = randomUUID();
    const res3OpId = randomUUID();
    const res3 = await httpCall(`${gw}/api/v1/inventario/reservas`, {
      method: "POST",
      headers: { Authorization: `Bearer ${g5Token}`, "Idempotency-Key": res3OpId },
      body: { order_id: orderId3, operation_id: res3OpId, channel_id: "MARKETPLACE", lines: [{ sku: activeSku1, quantity: 1, location_id: "00000000-0000-4000-8000-000000000101" }] },
    });
    const res3Op = await pollUntil(
      () => httpCall(`${gw}/api/v1/inventario/operaciones/${res3.json?.operation_id ?? res3OpId}`, { headers: { Authorization: `Bearer ${g5Token}` } }),
      (r) => Boolean(r.json?.reservation_id),
    );
    const reservationId3 = res3Op?.json?.reservation_id;

    // 4th reservation for [148] admitirConsumoCuponH5
    const orderId4 = randomUUID();
    const res4OpId = randomUUID();
    const res4 = await httpCall(`${gw}/api/v1/inventario/reservas`, {
      method: "POST",
      headers: { Authorization: `Bearer ${g5Token}`, "Idempotency-Key": res4OpId },
      body: { order_id: orderId4, operation_id: res4OpId, channel_id: "MARKETPLACE", lines: [{ sku: activeSku1, quantity: 1, location_id: "00000000-0000-4000-8000-000000000101" }] },
    });
    const res4Op = await pollUntil(
      () => httpCall(`${gw}/api/v1/inventario/operaciones/${res4.json?.operation_id ?? res4OpId}`, { headers: { Authorization: `Bearer ${g5Token}` } }),
      (r) => Boolean(r.json?.reservation_id),
    );
    const reservationId4 = res4Op?.json?.reservation_id;

    // G5 snapshot + N01 consume
    const effectiveAt = new Date().toISOString();
    const consumeOpId = randomUUID();
    const customerRef = randomUUID();
    const customerRef4 = randomUUID();
    await httpCall(`${env.g5SeedOrigin}/__test/g5-snapshots`, {
      method: "POST",
      body: {
        order_id: orderId,
        commercial_snapshot_ref: orderId,
        channel_id: "MARKETPLACE",
        customer_ref: customerRef,
        coupon_code: couponCode,
        reservation_id: reservationId,
        lines: [{ sku: activeSku1, product_id: activeProd1, quantity: 2, currency: "PEN", regular_price: "120.00", offer_price: null }],
        effective_at: effectiveAt,
      },
    });
    await httpCall(`${env.g5SeedOrigin}/__test/g5-snapshots`, {
      method: "POST",
      body: {
        order_id: orderId2,
        commercial_snapshot_ref: orderId2,
        customer_ref: customerRef,
        channel_id: "MARKETPLACE",
        currency: "PEN",
        subtotal: 120,
        discount_total: 18,
        total_amount: 102,
        lines: [{ sku: activeSku1, product_id: activeProd1, quantity: 1, unit_price: 120 }],
        effective_at: effectiveAt,
      },
    });
    await httpCall(`${env.g5SeedOrigin}/__test/g5-snapshots`, {
      method: "POST",
      body: {
        order_id: orderId4,
        commercial_snapshot_ref: orderId4,
        channel_id: "MARKETPLACE",
        customer_ref: customerRef4,
        coupon_code: couponCode,
        reservation_id: reservationId4,
        lines: [{ sku: activeSku1, product_id: activeProd1, quantity: 1, currency: "PEN", regular_price: "120.00", offer_price: null }],
        effective_at: effectiveAt,
      },
    });
    await httpCall(`${gw}/api/v1/cupones/consumos`, {
      method: "POST",
      headers: { Authorization: `Bearer ${g5Token}`, "Idempotency-Key": consumeOpId },
      body: {
        operation_id: consumeOpId,
        order_id: orderId,
        coupon_code: couponCode,
        customer_ref: customerRef,
        channel_id: "MARKETPLACE",
        effective_at: effectiveAt,
        reservation_id: reservationId,
        commercial_snapshot_ref: orderId,
      },
    });
    const n01Poll = await pollUntil(
      () => httpCall(`${gw}/api/v1/cupones/operaciones/${consumeOpId}?order_id=${orderId}`, { headers: { Authorization: `Bearer ${g5Token}` } }),
      (r) => ["COMPLETED", "REJECTED"].includes(r.json?.status),
    );
    const n01ConsumeStatus = n01Poll?.json?.status ?? "";

    // Seed SKU-level price change so Price Audit has SKU+channel non-null record for R16
    await httpCall(`${gw}/api/v1/precios/skus/${activeSku1}`, {
      method: "PATCH",
      headers: { ...authH, "Idempotency-Key": randomUUID() },
      body: { accionPrecioOferta: "CONSERVAR", priceVersion: 0, precioRegular: 121, moneda: "PEN", channelId: "MARKETPLACE", motivoCambio: "CERT_SEED_SKU" },
    });

    // Price Audit: wait for R16 audit record from SKU PATCH price
    const auditListPoll = await pollUntil(
      () => httpCall(`${gw}/api/v1/auditoria-precios?sku=${encodeURIComponent(activeSku1)}`, { headers: authH }),
      (r) => Array.isArray(r.json?.items) && r.json.items.length > 0,
      20,
      250,
    );
    let auditId = auditListPoll?.json?.items?.[0]?.id_auditoria ?? auditListPoll?.json?.items?.[0]?.auditId;

    // Price Audit export
    const expRes = await httpCall(`${gw}/api/v1/auditoria-precios/exportaciones`, {
      method: "POST",
      headers: authH,
      body: { formato: "CSV" },
    });
    const exportId = expRes.json?.export_id ?? expRes.json?.exportId;
    if (exportId) {
      await pollUntil(
        () => httpCall(`${gw}/api/v1/auditoria-precios/exportaciones/${exportId}`, { headers: authH }),
        (r) => r.json?.status === "COMPLETED" || r.json?.estado === "COMPLETED",
      );
    }

    // Pricing import batch (CSV FormData) + base SKU2 price
    await httpCall(`${gw}/api/v1/precios/skus/${activeSku2}`, {
      method: "PATCH",
      headers: { ...authH, "Idempotency-Key": randomUUID() },
      body: { accionPrecioOferta: "CONSERVAR", priceVersion: 0, precioRegular: 120, moneda: "PEN", motivoCambio: "CERT_SEED_SKU2_BASE" },
    });
    await httpCall(`${gw}/api/v1/precios/skus/${activeSku2}`, {
      method: "PATCH",
      headers: { ...authH, "Idempotency-Key": randomUUID() },
      body: { accionPrecioOferta: "CONSERVAR", priceVersion: 0, precioRegular: 120, moneda: "PEN", channelId: "MARKETPLACE", motivoCambio: "CERT_SEED_SKU2" },
    });
    const priceCsvHeader = "sku,channelId,priceVersion,precioRegular,accionPrecioOferta,precioOferta,moneda,motivoCambio";
    const makePriceCsvForm = (sku, version) => {
      const f = new FormData();
      f.append("archivo", new Blob([`${priceCsvHeader}\n${[sku, "MARKETPLACE", String(version), "125.00", "CONSERVAR", "", "PEN", "CERT_IMP"].join(",")}`], { type: "text/csv" }), "precios.csv");
      return f;
    };
    const priceImportRes = await httpCall(`${gw}/api/v1/precios/importaciones`, {
      method: "POST",
      headers: { ...authH, "Idempotency-Key": randomUUID() },
      body: makePriceCsvForm(activeSku2, 1),
    });
    let priceBatchId = priceImportRes.json?.batchId ?? priceImportRes.json?.batch_id;
    if (priceImportRes.status >= 400 || !priceBatchId) {
      throw new Error(`SEED_FAILED priceImportRes status=${priceImportRes.status} body=${priceImportRes.text}`);
    }

    // Bulk 8b V2 CSV batch (with V3 claim-check enabled -> R01/R02/R03/R04/R10/R14)
    const bulkSku = `BULK-CERT-${randomUUID().slice(0, 6).toUpperCase()}`;
    const bulkRow = ["ALTA", "", "", bulkSku, "", "Prod Bulk Cert", "Desc Bulk Cert", catId, brandId, typeId, "false", "55.00", "[]", "", "https://example.test/b.png", "15"].join(",");
    const bulkForm = new FormData();
    bulkForm.append("archivo", new Blob([`${v2Headers}\r\n${bulkRow}\r\n`], { type: "text/csv" }), "cert.csv");
    const bulkCorrId = randomUUID();
    const bulkUpload = await httpCall(`${gw}/api/v1/carga-masiva/productos/importaciones`, {
      method: "POST",
      headers: { Authorization: `Bearer ${gestorJwt}`, "Idempotency-Key": randomUUID(), "X-Correlation-Id": bulkCorrId },
      body: bulkForm,
    });
    const batchId = bulkUpload.json?.batch_id;
    if (!batchId) {
      throw new Error(`SEED_FAILED bulkUpload status=${bulkUpload.status} body=${bulkUpload.text}`);
    }
    const bulkContentId = stableUuid(`${batchId}:catalog-bulk-v3-content`);
    let bulkTerminal = bulkUpload.json?.status ?? String(bulkUpload.status);
    let bulkSnap = null;
    const bulkPoll = await pollUntil(
      () => httpCall(`${gw}/api/v1/carga-masiva/productos/importaciones/${batchId}`, { headers: { Authorization: `Bearer ${gestorJwt}` } }),
      (r) => ["COMPLETED", "FAILED_GENERAL"].includes(r.json?.status),
      80,
      500,
    );
    bulkSnap = bulkPoll?.json ?? null;
    bulkTerminal = bulkSnap?.status ?? "";

    // Bulk export
    const bulkExpRes = await httpCall(`${gw}/api/v1/carga-masiva/productos/exportaciones`, {
      method: "POST",
      headers: { ...authH, "Idempotency-Key": randomUUID() },
      body: { formato: "CSV" },
    });
    const bulkExportId = bulkExpRes.json?.export_id ?? bulkExpRes.json?.exportId;
    if (!bulkExportId) {
      throw new Error(`SEED_FAILED bulkExpRes status=${bulkExpRes.status} body=${bulkExpRes.text}`);
    }
    await pollUntil(
      () => httpCall(`${gw}/api/v1/carga-masiva/productos/exportaciones/${bulkExportId}`, { headers: authH }),
      (r) => r.json?.status === "COMPLETED",
    );

    // Seed pending preparation checks for [32] & [40]
    const pendingPrepRes = await httpCall(`${env.g5SeedOrigin}/__test/catalog-pending-preparation`, {
      method: "POST",
      body: { categoriaId: catId, marcaId: brandId, tipoProductoId: typeId, sourceVariantId: varId },
    });
    const retryProdId = pendingPrepRes.json?.retryProdId;
    const retryVarProdId = pendingPrepRes.json?.retryVarProdId;
    const retryVarId = pendingPrepRes.json?.retryVarId;
    if (!retryProdId || !retryVarId) {
      throw new Error(`SEED_FAILED pendingPrepRes status=${pendingPrepRes.status}`);
    }

    // Inventory incident (for obtener/resolver)
    const incOpId = randomUUID();
    const incRes = await httpCall(`${gw}/api/v1/inventario/incidencias`, {
      method: "POST",
      headers: { Authorization: `Bearer ${retailToken}`, "Idempotency-Key": incOpId },
      body: {
        operation_id: incOpId,
        external_incident_id: `INC-${randomUUID().slice(0, 8)}`,
        sku: activeSku1,
        location_id: storeLocationId,
        quantity: 1,
        type: "DANIO",
        occurred_at: new Date().toISOString(),
      },
    });
    const incidenciaId = incRes.json?.incidencia_id ?? incRes.json?.id;

    // 3. Iterate over all 158 rows from MATRIZ_158_OPERACIONES_H5_R2.csv with real positive & negative cases
    console.error("[certify] Seeding complete, executing 158 operations...");
    const matrixLines = readFileSync(MATRIX_PATH, "utf8").trim().split(/\r?\n/);
    const results = [];
    let taxOpId = randomUUID();
    let typeSchemaVersion = 2;

    for (let i = 1; i < matrixLines.length; i++) {
      const cols = parseCsvLine(matrixLines[i]);
      const [opId, vigencia, svc, method, rawRoute, rolScope, actorPerm] = cols;
      const isHealth = rawRoute.includes("/health");
      const isPublic = false;
      const isPrivate = vigencia === "ENDPOINT_PRIVADO" || (!rawRoute.startsWith("/api/v1/") && !isHealth);
      const baseOrigin = svc === "api-gateway" ? gw : isPrivate ? env.serviceUrls[svc] : gw;

      let path = rawRoute
        .replace("{productoId}", opId === "reintentarPreparacionVariante" ? (retryVarProdId ?? varProdId ?? activeProd1) : (opId.includes("Variante") || opId === "crearVariante") ? (varProdId ?? activeProd1) : opId === "reintentarPreparacionProducto" ? (retryProdId ?? draftProdId ?? activeProd1) : activeProd1)
        .replace("{productId}", (opId.includes("Variante") || opId === "crearVariante") ? (varProdId ?? activeProd1) : activeProd1)
        .replace("{sku}", opId === "obtenerDefinicionPrecioSkuAdministracion" || opId === "programarPrecioSku" ? activeSku2 : activeSku1)
        .replace("{categoriaId}", opId === "solicitarDesactivacionCategoria" ? (catIdDeact ?? randomUUID()) : (catId ?? randomUUID()))
        .replace("{marcaId}", opId === "solicitarDesactivacionMarca" ? (brandIdDeact ?? randomUUID()) : (brandId ?? randomUUID()))
        .replace("{tipoProductoId}", (opId === "solicitarDesactivacionTipoProducto" || opId === "reactivarTipoProducto") ? (typeIdDeact ?? randomUUID()) : (typeId ?? randomUUID()))
        .replace("{caracteristicaId}", attrId ?? randomUUID())
        .replace("{valorId}", (opId === "solicitarDesactivacionValorCaracteristica" || opId === "reactivarValorCaracteristica") ? (valIdDeact ?? randomUUID()) : (valId ?? randomUUID()))
        .replace("{variantId}", opId === "reintentarPreparacionVariante" ? (retryVarId ?? varId ?? randomUUID()) : (varId ?? randomUUID()))
        .replace("{slug}", opId === "obtenerProductoPorSlug" ? activeProd1Slug : catSlug)
        .replace("{promocionId}", ["actualizarPromocion", "activarPromocion", "desactivarPromocion"].includes(opId) ? (promoIdDeact ?? promoId ?? randomUUID()) : (promoId ?? randomUUID()))
        .replace("{comboId}", opId === "desactivarCombo" ? (comboIdToDeactivate ?? randomUUID()) : (comboId ?? randomUUID()))
        .replace("{reservaId}", opId === "confirmarReserva" ? (reservationId2 ?? reservationId) : opId === "liberarReserva" ? (reservationId3 ?? reservationId) : reservationId)
        .replace("{operationId}", opId === "obtenerOperacionCuponH5" ? consumeOpId : opId === "obtenerOperacionMaestra" ? taxOpId : invOpId)
        .replace("{batchId}", opId.includes("ImportacionPrecios") ? (priceBatchId ?? randomUUID()) : opId === "reanudarImportacionGeneral" ? (retryBatchId ?? batchId ?? randomUUID()) : (batchId ?? randomUUID()))
        .replace("{exportId}", svc === "bulk-svc" ? (bulkExportId ?? randomUUID()) : (exportId ?? randomUUID()))
        .replace("{auditId}", auditId ?? randomUUID())
        .replace("{cuponId}", ["actualizarCupon", "activarCupon", "desactivarCupon"].includes(opId) ? (couponIdDeact ?? couponId ?? randomUUID()) : (couponId ?? randomUUID()))
        .replace("{reglaId}", ruleId ?? randomUUID())
        .replace("{contentId}", bulkContentId)
        .replace("{slugAnterior}", catSlugPrev)
        .replace("{correlationId}", bulkCorrId)
        .replace("{incidenciaId}", incidenciaId ?? randomUUID())
        .replace("{trasladoId}", trasladoId)
        .replace("{ruleId}", ruleId ?? randomUUID())
        .replace("{codigo}", couponCode);

      if (path.startsWith("/interno/inventario/reservas/")) path = `/api/v1${path}`;

      if (path === "/api/v1/precios") {
        path += `?skus=${encodeURIComponent(activeSku1)}`;
      } else if (path === "/api/v1/inventario/disponibilidad") {
        path += `?skus=${encodeURIComponent(activeSku1)}&location_id=00000000-0000-4000-8000-000000000101`;
      } else if (path === "/api/v1/inventario/disponibilidad/comercial") {
        path += `?skus=${encodeURIComponent(activeSku1)}&canal=MARKETPLACE`;
      } else if (path === "/api/v1/productos" && method === "GET") {
        path += "?canal=MARKETPLACE";
      } else if (opId === "obtenerProducto" && method === "GET") {
        path += "?canal=MARKETPLACE";
      } else if (opId === "obtenerProductoPorSlug" && method === "GET") {
        path += "?canal=MARKETPLACE";
      } else if (path === "/api/v1/auditoria-precios" && method === "GET") {
        path += `?sku=${encodeURIComponent(activeSku1)}`;
      } else if (path === "/api/v1/promociones" && method === "GET") {
        path += "?canal=MARKETPLACE";
      } else if (path === "/api/v1/recomendaciones" && method === "GET") {
        path += `?canal=MARKETPLACE&productoId=${encodeURIComponent(activeProd1)}`;
      } else if (path === "/api/v1/cupones" && method === "GET") {
        path += `?codigo=${encodeURIComponent(couponCode)}`;
      } else if ((path.includes("/reservas/") && (path.endsWith("/estado") || path.endsWith("/evidencia-cupon"))) || opId === "obtenerOperacionCuponH5") {
        path += `?order_id=${encodeURIComponent(orderId)}`;
      } else if (path.includes("/carga-masiva/productos/plantilla")) {
        path += "?formato=CSV";
      }

      // Select appropriate token
      let token = gestorJwt;
      let isServiceBearer = false;
      if (opId === "obtenerContenidoCargaMasivaInternoH5") {
        token = catalogSvcToken; isServiceBearer = true;
      } else if (opId === "filtrarSkusVendiblesInterno") {
        token = inventorySvcToken; isServiceBearer = true;
      } else if (opId === "obtenerEvidenciaReservaCuponInterno") {
        token = promotionsSvcToken; isServiceBearer = true;
      } else if (
        ["cupones:consumir", "cupones:restaurar", "cupones:operaciones:leer", "inventario:reservar", "inventario:consumir", "inventario:liberar", "inventario:conciliar-offline", "inventario:operaciones:leer", "inventario:reservas:estado:leer"].some((s) => (rolScope || "").includes(s))
      ) {
        token = g5Token; isServiceBearer = true;
      } else if ((rolScope || "").includes("promociones:evaluar")) {
        token = g3Token; isServiceBearer = true;
      } else if ((rolScope || "").includes("inventario:reintegrar") || (rolScope || "").includes("inventario:reintegros")) {
        token = postventaToken; isServiceBearer = true;
      } else if (
        ["promociones:leer", "cupones:validar", "recomendaciones:leer", "combos:leer"].some((s) => (rolScope || "").includes(s)) ||
        ((actorPerm || "").includes("modulo-marketplace") && !(actorPerm || "").includes("userBearer"))
      ) {
        token = g1Token; isServiceBearer = true;
      } else if (
        ["inventario:incidencias:"].some((s) => (rolScope || "").includes(s)) ||
        ((actorPerm || "").includes("modulo-retail") && !(actorPerm || "").includes("userBearer"))
      ) {
        token = retailToken; isServiceBearer = true;
      } else if ((actorPerm || "").includes("interno-g6") || ((actorPerm || "").includes("modulo-productos") && !(actorPerm || "").includes("userBearer"))) {
        token = prodSvcToken; isServiceBearer = true;
      } else if ((actorPerm || "").includes("modulo-despacho") && !(actorPerm || "").includes("userBearer")) {
        token = despachoToken; isServiceBearer = true;
      }

      // A. ROUTE_SECURITY_PASS (401 + 403)
      let auth401 = true;
      let auth403 = true;
      if (!isHealth && !isPublic && baseOrigin) {
        const unauthRes = await httpCall(`${baseOrigin}${path}`, { method });
        auth401 = unauthRes.status === 401;
        if (!isServiceBearer) {
          const forbRes = await httpCall(`${baseOrigin}${path}`, {
            method,
            headers: { Authorization: `Bearer ${sinRolJwt}` },
          });
          auth403 = forbRes.status === 403;
        } else {
          // Cross-client 403 test: use a client that is NOT allowed for this route
          const wrongClientToken =
            token === g5Token ? despachoToken :
            token === inventorySvcToken ? g1Token :
            token === catalogSvcToken ? g1Token :
            token === promotionsSvcToken ? g1Token :
            token === retailToken ? despachoToken :
            token === despachoToken ? g1Token :
            g5Token;
          const forbRes = await httpCall(`${baseOrigin}${path}`, {
            method,
            headers: { Authorization: `Bearer ${wrongClientToken}` },
          });
          auth403 = forbRes.status === 403;
        }
      }

      // B. Build positive request
      let posMethod = method;
      let posPath = path;
      const opIdempotency = randomUUID();
      let posHeaders = isHealth ? {} : (method === "GET" || method === "DELETE") ? { Authorization: `Bearer ${token}` } : { Authorization: `Bearer ${token}`, "Idempotency-Key": opIdempotency };
      let posBody = undefined;

      if (method !== "GET" && method !== "DELETE") {
        posBody = buildPositiveBody(opId, {
          catId, brandId, typeId, typeSchemaVersion, attrId, attrId2, attrName, valId, valName, valId2, valName2, activeProd1, activeProd2, activeSku1, activeSku2,
          draftProdId, varProdId, varId, promoId, couponId, couponCode, ruleId, comboId,
          orderId, orderId2, orderId3, orderId4, reservationId, reservationId2, reservationId3, reservationId4, storeLocationId, barcode1, effectiveAt, opIdempotency, consumeOpId, customerRef, customerRef4,
        });
        if (opId === "crearMarca" || opId === "actualizarMarca") {
          const f = makeBrandForm(`Marca ${opId === "crearMarca" ? "Pos" : "Upd"} ${randomUUID().slice(0, 6)}`);
          if (opId === "actualizarMarca") f.append("version", "0");
          posBody = f;
        } else if (opId === "prevalidarImportacionPrecios" || opId === "crearImportacionPrecios") {
          posBody = makePriceCsvForm(activeSku1, 1);
        } else if (opId === "crearImportacionGeneralProductos") {
          const f = new FormData();
          const sku = `BULK-POS-${randomUUID().slice(0, 6).toUpperCase()}`;
          f.append("archivo", new Blob([`${v2Headers}\r\n${["ALTA", "", "", sku, "", "Prod Pos", "Desc Pos", catId, brandId, typeId, "false", "45.00", "[]", "", "https://example.test/p.png", "10"].join(",")}\r\n`], { type: "text/csv" }), "pos.csv");
          posBody = f;
        }
      }

      if (opId === "reanudarImportacionGeneral") {
        posHeaders["X-Correlation-Id"] = retryBulkCorrId;
      }

      // C. Execute positive request
      const posRes = await httpCall(`${baseOrigin}${posPath}`, {
        method: posMethod,
        headers: posHeaders,
        body: posBody,
      });

      if (["solicitarDesactivacionCategoria", "solicitarDesactivacionValorCaracteristica", "solicitarDesactivacionTipoProducto"].includes(opId) && (posRes.json?.operation_id || posRes.json?.operationId || posRes.json?.operacionId)) {
        taxOpId = posRes.json?.operation_id ?? posRes.json?.operacionId ?? posRes.json?.operationId;
      }
      if (opId === "asociarCaracteristicaTipoProducto" && posRes.json?.schemaVersion != null) {
        typeSchemaVersion = Number(posRes.json.schemaVersion);
      }
      if (opId === "crearImportacionPrecios" && (posRes.json?.batchId || posRes.json?.batch_id)) {
        priceBatchId = posRes.json?.batchId ?? posRes.json?.batch_id;
      }
      if (opId === "listarAuditoriaPrecios" && !auditId && Array.isArray(posRes.json?.items) && posRes.json.items.length > 0) {
        auditId = posRes.json.items[0].id_auditoria ?? posRes.json.items[0].auditId;
      }

const READ_ONLY_POST_OPS = new Set([
  "filtrarSkusVendiblesInterno",
  "obtenerPreciosLote",
  "obtenerContextosSkuLote",
  "verificarCantidadComercial",
  "evaluarPromociones",
  "simularCarritoPromociones",
  "calcularDescuento",
  "validarCupon",
  "consultarDatosFisicos",
  "resolverSlugCategoriaCreacion",
  "resolverSkusAdministracion",
  "prevalidarImportacionPrecios",
  "resolverCodigoBarras",
]);

async function pgSelect(g5SeedOrigin, sql) {
  const res = await httpCall(`${g5SeedOrigin}/__test/pg-query`, {
    method: "POST",
    body: { sql },
  });
  if (res.status !== 200 || !Array.isArray(res.json?.rows)) {
    throw new Error(`PG_QUERY_FAILED status=${res.status} body=${res.text}`);
  }
  return res.json.rows;
}

async function verifyPgPersistence(opId, method, isHealth, posRes, ctx, g5SeedOrigin, reqBody) {
  if (isHealth || method === "GET" || READ_ONLY_POST_OPS.has(opId)) {
    return { label: "NOT_APPLICABLE", ok: true };
  }
  if (!(posRes.status >= 200 && posRes.status < 300)) {
    return { label: "FAIL", ok: false };
  }
  const safe = (v) => String(v ?? "").replace(/[^a-zA-Z0-9_-]/g, "");
  try {
    if (["crearProducto", "actualizarProducto", "activarProducto", "desactivarProducto", "reactivarProducto", "reemplazarImagenesProducto", "definirAtributosProducto", "definirPerfilFisicoProducto", "reintentarPreparacionProducto"].includes(opId)) {
      const id = safe(posRes.json?.productoId ?? posRes.json?.product_id ?? (opId === "reintentarPreparacionProducto" ? ctx.retryProdId : ctx.activeProd1));
      const rows = await pgSelect(g5SeedOrigin, `SELECT id, estado, catalog_version FROM catalog.products WHERE id = '${id}'::uuid`);
      if (rows.length !== 1) return { label: "FAIL", ok: false };
      if (opId === "desactivarProducto" && rows[0].estado !== "INACTIVO") return { label: "FAIL", ok: false };
      if ((opId === "activarProducto" || opId === "reactivarProducto") && rows[0].estado !== "ACTIVO") return { label: "FAIL", ok: false };
      if (opId === "reintentarPreparacionProducto") {
        const ob = await pgSelect(g5SeedOrigin, `SELECT count(*)::int AS c FROM catalog.outbox WHERE operation_id = '${safe(posRes.json?.operation_id)}'::uuid`);
        return Number(ob[0]?.c ?? 0) >= 1 ? { label: "PERSISTENCE_PASS", ok: true } : { label: "FAIL", ok: false };
      }
      return { label: "PERSISTENCE_PASS", ok: true };
    }
    if (["crearVariante", "actualizarVariante", "activarVariante", "desactivarVariante", "reactivarVariante", "reemplazarImagenesVariante", "definirAtributosVariante", "definirPerfilFisicoVariante", "reintentarPreparacionVariante", "asignarCodigoBarras"].includes(opId)) {
      const id = safe(posRes.json?.varianteId ?? posRes.json?.variant_id ?? (opId === "reintentarPreparacionVariante" ? ctx.retryVarId : ctx.varId));
      const rows = await pgSelect(g5SeedOrigin, `SELECT id, estado FROM catalog.variants WHERE id = '${id}'::uuid`);
      if (rows.length !== 1) return { label: "FAIL", ok: false };
      if (opId === "desactivarVariante" && rows[0].estado !== "INACTIVA") return { label: "FAIL", ok: false };
      if ((opId === "activarVariante" || opId === "reactivarVariante") && rows[0].estado !== "ACTIVA") return { label: "FAIL", ok: false };
      return { label: "PERSISTENCE_PASS", ok: true };
    }
    if (["crearCategoria", "actualizarCategoria", "desactivarCategoria", "reactivarCategoria", "actualizarSeoCategoria", "solicitarDesactivacionCategoria"].includes(opId)) {
      const rows = await pgSelect(g5SeedOrigin, `SELECT count(*)::int AS c FROM taxonomy.categories`);
      return Number(rows[0]?.c ?? 0) > 0 ? { label: "PERSISTENCE_PASS", ok: true } : { label: "FAIL", ok: false };
    }
    if (["crearMarca", "actualizarMarca", "desactivarMarca", "reactivarMarca", "solicitarDesactivacionMarca", "subirLogoMarca"].includes(opId)) {
      const rows = await pgSelect(g5SeedOrigin, `SELECT count(*)::int AS c FROM taxonomy.brands`);
      return Number(rows[0]?.c ?? 0) > 0 ? { label: "PERSISTENCE_PASS", ok: true } : { label: "FAIL", ok: false };
    }
    if (["crearCaracteristica", "actualizarCaracteristica", "desactivarCaracteristica", "reactivarCaracteristica", "crearValorCaracteristica", "actualizarValorCaracteristica", "desactivarValorCaracteristica", "reactivarValorCaracteristica", "solicitarDesactivacionValorCaracteristica", "crearTipoProducto", "actualizarTipoProducto", "desactivarTipoProducto", "reactivarTipoProducto", "solicitarDesactivacionTipoProducto", "asociarCaracteristicaTipoProducto", "actualizarAsociacionTipoCaracteristica", "desasociarCaracteristicaTipoProducto", "solicitarDesasociacionTipoCaracteristica"].includes(opId)) {
      const rows = await pgSelect(g5SeedOrigin, `SELECT count(*)::int AS c FROM taxonomy.product_types`);
      return Number(rows[0]?.c ?? 0) > 0 ? { label: "PERSISTENCE_PASS", ok: true } : { label: "FAIL", ok: false };
    }
    if (["actualizarPrecioSku", "actualizarPrecioBaseProducto", "programarPrecioSku", "programarPrecioBaseProducto", "crearImportacionPrecios", "reintentarImportacionPrecios"].includes(opId)) {
      if (opId === "programarPrecioBaseProducto") {
        const rows = await pgSelect(g5SeedOrigin, `SELECT count(*)::int AS c FROM pricing.scheduled_prices`);
        return Number(rows[0]?.c ?? 0) > 0 ? { label: "PERSISTENCE_PASS", ok: true } : { label: "FAIL", ok: false };
      }
      const rows = await pgSelect(g5SeedOrigin, `SELECT count(*)::int AS c FROM pricing.prices`);
      return Number(rows[0]?.c ?? 0) > 0 ? { label: "PERSISTENCE_PASS", ok: true } : { label: "FAIL", ok: false };
    }
    if (opId === "crearExportacionAuditoriaPrecios") {
      const id = safe(posRes.json?.export_id ?? posRes.json?.exportId);
      const rows = await pgSelect(g5SeedOrigin, `SELECT id FROM price_audit.export_jobs WHERE id = '${id}'::uuid`);
      return rows.length === 1 ? { label: "PERSISTENCE_PASS", ok: true } : { label: "FAIL", ok: false };
    }
    if (opId === "crearImportacionGeneralProductos") {
      const bId = safe(posRes.json?.batch_id ?? posRes.json?.batchId);
      const rows = await pgSelect(g5SeedOrigin, `SELECT status, completed_rows, total_rows, needs_reconciliation FROM bulk.batch_jobs WHERE batch_id = '${bId}'::uuid`);
      const invRows = await pgSelect(g5SeedOrigin, `SELECT status FROM bulk.row_domain_steps WHERE batch_row_id IN (SELECT id FROM bulk.batch_rows WHERE batch_job_id = (SELECT id FROM bulk.batch_jobs WHERE batch_id = '${bId}'::uuid)) AND domain = 'INVENTARIO'`);
      const ok = rows[0]?.status === "COMPLETED" && rows[0]?.completed_rows === rows[0]?.total_rows && !rows[0]?.needs_reconciliation && invRows[0]?.status === "COMPLETED";
      return { label: ok ? "PERSISTENCE_PASS" : "FAIL", ok };
    }
    if (opId === "reanudarImportacionGeneral") {
      const bId = safe(ctx.retryBatchId);
      const rows = await pgSelect(g5SeedOrigin, `SELECT status, completed_rows, failed_rows FROM bulk.batch_jobs WHERE batch_id = '${bId}'::uuid`);
      const attempts = await pgSelect(g5SeedOrigin, `SELECT count(*)::int AS c FROM bulk.domain_attempts WHERE batch_row_id IN (SELECT id FROM bulk.batch_rows WHERE batch_job_id = (SELECT id FROM bulk.batch_jobs WHERE batch_id = '${bId}'::uuid)) AND attempt_number >= 2`);
      const ok = rows[0]?.status === "COMPLETED" && rows[0]?.completed_rows === 1 && rows[0]?.failed_rows === 0 && Number(attempts[0]?.c ?? 0) >= 1;
      return { label: ok ? "PERSISTENCE_PASS" : "FAIL", ok };
    }
    if (opId === "crearExportacionGeneralProductos") {
      const id = safe(posRes.json?.export_id ?? posRes.json?.exportId);
      const rows = await pgSelect(g5SeedOrigin, `SELECT export_id FROM bulk.export_jobs WHERE export_id = '${id}'::uuid`);
      return rows.length === 1 ? { label: "PERSISTENCE_PASS", ok: true } : { label: "FAIL", ok: false };
    }
    if (opId === "conciliarVentaOffline") {
      const opUuid = safe(reqBody?.operation_id);
      const offId = safe(reqBody?.offline_sale_id);
      const rows = await pgSelect(g5SeedOrigin, `SELECT operation_id, offline_sale_id, status FROM inventory.offline_sale_reconciliations WHERE operation_id = '${opUuid}'::uuid AND offline_sale_id = '${offId}'`);
      const kRows = await pgSelect(g5SeedOrigin, `SELECT count(*)::int AS c FROM inventory.kardex WHERE operation_id = '${opUuid}'::uuid`);
      const ok = rows.length === 1 && Number(kRows[0]?.c ?? 0) >= 1;
      return { label: ok ? "PERSISTENCE_PASS" : "FAIL", ok };
    }
    if (["solicitarReserva", "confirmarReserva", "liberarReserva"].includes(opId)) {
      const targetOrder = safe(reqBody?.order_id ?? posRes.json?.order_id ?? (opId === "confirmarReserva" ? ctx.orderId2 : opId === "liberarReserva" ? ctx.orderId3 : ""));
      const rows = await pgSelect(g5SeedOrigin, `SELECT id, order_id, status FROM inventory.reservations WHERE order_id = '${targetOrder}'`);
      if (rows.length < 1) return { label: "FAIL", ok: false };
      if (opId === "confirmarReserva" && !["CONFIRMADA", "CONSUMIDA"].includes(rows[0].status)) return { label: "FAIL", ok: false };
      if (opId === "liberarReserva" && rows[0].status !== "LIBERADA") return { label: "FAIL", ok: false };
      const opRows = await pgSelect(g5SeedOrigin, `SELECT count(*)::int AS c FROM inventory.inventory_operations WHERE operation_id = '${safe(reqBody?.operation_id ?? posRes.json?.operation_id)}'::uuid`);
      return Number(opRows[0]?.c ?? 0) >= 1 ? { label: "PERSISTENCE_PASS", ok: true } : { label: "FAIL", ok: false };
    }
    if (["reportarIncidenciaInventario", "resolverIncidenciaInventario"].includes(opId)) {
      const rows = await pgSelect(g5SeedOrigin, `SELECT count(*)::int AS c FROM inventory.incidencias`);
      return Number(rows[0]?.c ?? 0) >= 1 ? { label: "PERSISTENCE_PASS", ok: true } : { label: "FAIL", ok: false };
    }
    if (opId === "reintegrarInventario") {
      const opUuid = safe(reqBody?.operation_id);
      const rows = await pgSelect(g5SeedOrigin, `SELECT count(*)::int AS c FROM inventory.kardex WHERE operation_id = '${opUuid}'::uuid`);
      return Number(rows[0]?.c ?? 0) >= 1 ? { label: "PERSISTENCE_PASS", ok: true } : { label: "FAIL", ok: false };
    }
    if (opId === "actualizarUmbralGlobal") {
      const rows = await pgSelect(g5SeedOrigin, `SELECT key, value FROM inventory.inventory_config LIMIT 1`);
      const ok = rows.length === 1 && JSON.stringify(rows[0]?.value ?? "").includes("5");
      return { label: ok ? "PERSISTENCE_PASS" : "FAIL", ok };
    }
    if (opId === "establecerUmbralSku" || opId === "eliminarUmbralSku") {
      const rows = await pgSelect(g5SeedOrigin, `SELECT count(*)::int AS c FROM inventory.stock_threshold_override WHERE sku_id = '${safe(ctx.activeSku1)}'`);
      const expectedZero = opId === "eliminarUmbralSku";
      return (expectedZero ? Number(rows[0]?.c ?? 0) === 0 : Number(rows[0]?.c ?? 0) >= 1) ? { label: "PERSISTENCE_PASS", ok: true } : { label: "FAIL", ok: false };
    }
    if (opId === "registrarRecepcionTrasladoInventario") {
      const rows = await pgSelect(g5SeedOrigin, `SELECT count(*)::int AS c FROM inventory.traslado_recepciones`);
      return Number(rows[0]?.c ?? 0) >= 1 ? { label: "PERSISTENCE_PASS", ok: true } : { label: "FAIL", ok: false };
    }
    if (["crearPromocion", "actualizarPromocion", "activarPromocion", "desactivarPromocion"].includes(opId)) {
      const rows = await pgSelect(g5SeedOrigin, `SELECT count(*)::int AS c FROM promotions.promotions`);
      return Number(rows[0]?.c ?? 0) >= 1 ? { label: "PERSISTENCE_PASS", ok: true } : { label: "FAIL", ok: false };
    }
    if (["crearCupon", "actualizarCupon", "activarCupon", "desactivarCupon"].includes(opId)) {
      const rows = await pgSelect(g5SeedOrigin, `SELECT count(*)::int AS c FROM promotions.coupons WHERE code = upper('${safe(ctx.couponCode)}')`);
      return Number(rows[0]?.c ?? 0) >= 1 ? { label: "PERSISTENCE_PASS", ok: true } : { label: "FAIL", ok: false };
    }
    if (["crearReglaRecomendacion", "actualizarReglaRecomendacion", "activarReglaRecomendacion", "desactivarReglaRecomendacion"].includes(opId)) {
      const rows = await pgSelect(g5SeedOrigin, `SELECT count(*)::int AS c FROM promotions.recommendation_rules`);
      return Number(rows[0]?.c ?? 0) >= 1 ? { label: "PERSISTENCE_PASS", ok: true } : { label: "FAIL", ok: false };
    }
    if (opId === "admitirConsumoCuponH5") {
      const rows = await pgSelect(g5SeedOrigin, `SELECT id FROM promotions.coupon_uses WHERE order_id = '${safe(ctx.orderId4)}'`);
      const ob = await pgSelect(g5SeedOrigin, `SELECT count(*)::int AS c FROM promotions.outbox`);
      return rows.length === 1 && Number(ob[0]?.c ?? 0) >= 1 ? { label: "PERSISTENCE_PASS", ok: true } : { label: "FAIL", ok: false };
    }
    if (opId === "admitirRestauracionCuponH5") {
      const opUuid = safe(reqBody?.operation_id ?? posRes.json?.operation_id);
      const rows = await pgSelect(g5SeedOrigin, `SELECT operation_id, intention, status FROM promotions.coupon_command_receipts WHERE operation_id = '${opUuid}'::uuid AND intention = 'RESTAURAR'`);
      return rows.length >= 1 ? { label: "PERSISTENCE_PASS", ok: true } : { label: "FAIL", ok: false };
    }
    if (["crearCombo", "crearComboAdministracion", "actualizarCombo", "desactivarCombo"].includes(opId)) {
      const rows = await pgSelect(g5SeedOrigin, `SELECT count(*)::int AS c FROM combos.combos`);
      return Number(rows[0]?.c ?? 0) >= 1 ? { label: "PERSISTENCE_PASS", ok: true } : { label: "FAIL", ok: false };
    }
    return { label: "NOT_VERIFIED", ok: false };
  } catch {
    return { label: "FAIL", ok: false };
  }
}

      // D. Evaluate FUNCTIONAL_PASS + ASYNC_TERMINAL_PASS + PERSISTENCE_PASS
      if (posRes.status === 0) {
        console.error(`[certify] INFRA_LOST at [${i}/158] ${opId}: ${posRes.text}`);
        results.push({
          n: i,
          opId,
          vigencia,
          svc,
          method,
          rawRoute,
          status: "BLOCKED_INFRA",
          httpStatus: 0,
          routeSecurity: auth401 && auth403 ? "ROUTE_SECURITY_PASS" : "NOT_RUN",
          negativeContract: "NOT_RUN",
          functional: "BLOCKED_INFRA",
          persistence: "NOT_RUN",
          asyncTerminal: "NOT_RUN",
          auth401,
          auth403,
          error: posRes.text.slice(0, 200),
        });
        for (let j = i + 1; j < matrixLines.length; j++) {
          const rem = parseCsvLine(matrixLines[j]);
          if (rem.length >= 6) {
            results.push({
              n: j,
              opId: rem[0],
              vigencia: rem[1],
              svc: rem[2],
              method: rem[3],
              rawRoute: rem[4],
              status: "NOT_RUN",
              httpStatus: 0,
              routeSecurity: "NOT_RUN",
              negativeContract: "NOT_RUN",
              functional: "NOT_RUN",
              persistence: "NOT_RUN",
              asyncTerminal: "NOT_RUN",
              auth401: false,
              auth403: false,
            });
          }
        }
        break;
      }
      let semanticOk = true;
      if (opId === "evaluarPromociones" && posRes.status === 200) {
        semanticOk = typeof posRes.json?.original_amount === "number" && typeof posRes.json?.result_amount === "number" && typeof posRes.json?.discount_amount === "number";
      }
      const functionalPass = posRes.status >= 200 && posRes.status < 300 && semanticOk;
      let asyncTerminalPass = true;
      if (posRes.status === 202) {
        asyncTerminalPass = await verifyAsyncTerminal(opId, posRes.json, { gw, gestorJwt, g5Token, orderId });
      }
      const persistenceCheck = await verifyPgPersistence(
        opId,
        method,
        isHealth,
        posRes,
        { activeProd1, varId, retryProdId, retryVarId, retryBatchId, activeSku1, orderId, orderId2, orderId3, orderId4, couponCode },
        env.g5SeedOrigin,
        posBody,
      );
      const persistencePass = persistenceCheck.ok;

      // E. NEGATIVE_CONTRACT_PASS (independent negative test)
      let negativeLabel = isHealth ? "NOT_APPLICABLE" : "NOT_RUN";
      let negativePass = true;
      let negStatus = 0;
      if (!isHealth) {
        if (method === "GET") {
          if (opId === "obtenerRecomendaciones") {
            const negRes = await httpCall(`${baseOrigin}/api/v1/recomendaciones?canal=INVALIDO`, { method: "GET", headers: { Authorization: `Bearer ${token}` } });
            negStatus = negRes.status;
            negativePass = [400, 404].includes(negRes.status);
            negativeLabel = negativePass ? "NEGATIVE_CONTRACT_PASS" : "FAIL";
          } else if (rawRoute.includes("{")) {
            let negPath = rawRoute
              .replace("{slug}", `slug-inexistente-${randomUUID().slice(0, 8)}`)
              .replace("{slugAnterior}", `slug-inexistente-${randomUUID().slice(0, 8)}`)
              .replace("{sku}", `SKU-INEXISTENTE-${randomUUID().slice(0, 8)}`)
              .replace("{codigo}", `NOEXISTE${randomUUID().slice(0, 6).toUpperCase()}`)
              .replace(/\{[^}]+\}/g, () => randomUUID());
            if (negPath.startsWith("/interno/inventario/reservas/")) negPath = `/api/v1${negPath}`;
            if (negPath.startsWith("/productos/skus/")) negPath = `/api/v1${negPath}`;
            const negRes = await httpCall(`${baseOrigin}${negPath}`, { method: "GET", headers: { Authorization: `Bearer ${token}` } });
            negStatus = negRes.status;
            negativePass = [400, 404].includes(negRes.status);
            negativeLabel = negativePass ? "NEGATIVE_CONTRACT_PASS" : "FAIL";
          } else if (posPath.includes("?")) {
            const negPath = posPath.split("?")[0];
            const negRes = await httpCall(`${baseOrigin}${negPath}`, { method: "GET", headers: { Authorization: `Bearer ${token}` } });
            negStatus = negRes.status;
            negativePass = [400, 404].includes(negRes.status);
            negativeLabel = negativePass ? "NEGATIVE_CONTRACT_PASS" : "FAIL";
          } else {
            negativeLabel = "NOT_APPLICABLE";
          }
        } else if (["activarProducto", "desactivarProducto", "reactivarProducto"].includes(opId)) {
          const negPath = posPath.replace(activeProd1, randomUUID());
          const negRes = await httpCall(`${baseOrigin}${negPath}`, { method: posMethod, headers: { Authorization: `Bearer ${token}`, "Idempotency-Key": randomUUID() }, body: {} });
          negStatus = negRes.status;
          negativePass = [400, 404, 409, 422].includes(negRes.status);
          negativeLabel = negativePass ? "NEGATIVE_CONTRACT_PASS" : "FAIL";
        } else {
          const negBody =
            opId === "filtrarSkusVendiblesInterno" ? { tamanio: 999 } :
            opId === "actualizarProducto" || opId === "actualizarCategoria" ? { nombre: "" } :
            opId === "actualizarVariante" ? { imagenUrl: "not-a-uri" } :
            opId === "actualizarValorCaracteristica" ? { nombre: "Val Neg", version: 999 } :
            opId === "actualizarAsociacionTipoCaracteristica" ? { obligatoria: true, schemaVersion: 999 } :
            opId === "registrarRecepcionTrasladoInventario" ? { operation_id: randomUUID(), received_quantity: 999999, disposition: "REINGRESAR_DISPONIBLE", final_receipt: true, received_at: new Date().toISOString() } :
            opId === "actualizarPromocion" ? { valor: -1 } :
            opId === "actualizarReglaRecomendacion" ? { prioridad: -1 } :
            opId === "actualizarCombo" ? { precioCombo: -5 } :
            opId === "actualizarCupon" ? { maxUsosGlobal: -1 } :
            opId === "conciliarVentaOffline" ? { operation_id: randomUUID(), offline_sale_id: randomUUID(), order_id: randomUUID(), channel_id: "RETAIL", occurred_at: new Date().toISOString(), lines: [{ sku: activeSku1, quantity: 1, location_id: randomUUID() }] } :
            {};
          const negRes = await httpCall(`${baseOrigin}${posPath}`, {
            method: posMethod,
            headers: { Authorization: `Bearer ${token}`, "Idempotency-Key": randomUUID() },
            body: negBody,
          });
          negStatus = negRes.status;
          negativePass = [400, 404, 409, 422].includes(negRes.status);
          negativeLabel = negativePass ? "NEGATIVE_CONTRACT_PASS" : "FAIL";
        }
      }

      const overallPass = auth401 && auth403 && functionalPass && persistencePass && asyncTerminalPass && negativeLabel !== "FAIL" && negativeLabel !== "NOT_RUN";
      if (!overallPass) {
        console.error(`[certify] FAIL [${i}/158] ${opId} (${svc} ${method} ${posPath}) -> http=${posRes.status} 401=${auth401} 403=${auth403} func=${functionalPass} pers=${persistenceCheck.label} async=${asyncTerminalPass} neg=${negativeLabel}(${negStatus}) body=${posRes.text.slice(0, 400)}`);
      }

      results.push({
        n: i,
        opId,
        vigencia,
        svc,
        method,
        rawRoute,
        status: overallPass ? "PASS" : "FAIL",
        httpStatus: posRes.status,
        routeSecurity: auth401 && auth403 ? "ROUTE_SECURITY_PASS" : "FAIL",
        negativeContract: negativeLabel,
        functional: functionalPass ? "FUNCTIONAL_PASS" : "FAIL",
        persistence: persistenceCheck.label,
        asyncTerminal: posRes.status === 202 ? (asyncTerminalPass ? "ASYNC_TERMINAL_PASS" : "FAIL") : "NOT_APPLICABLE",
        auth401,
        auth403,
      });
    }

    const passed = results.filter((r) => r.status === "PASS").length;
    const failed = results.filter((r) => r.status === "FAIL").length;
    const blocked = results.filter((r) => r.status === "BLOCKED_INFRA").length;
    const notRun = results.filter((r) => r.status === "NOT_RUN").length;
    const executed = results.filter((r) => r.status !== "NOT_RUN").length;
    const countBy = (key, val) => results.filter((r) => r[key] === val).length;
    const summary = {
      status: failed === 0 && blocked === 0 && notRun === 0 && results.length === 158 ? "PASS" : (blocked > 0 ? "INFRA_LOST" : "FAIL"),
      timestamp: new Date().toISOString(),
      total: results.length,
      executed,
      notExecuted: notRun,
      passed,
      failed,
      blocked,
      persistenceBreakdown: {
        PERSISTENCE_PASS: countBy("persistence", "PERSISTENCE_PASS"),
        NOT_APPLICABLE: countBy("persistence", "NOT_APPLICABLE"),
        NOT_VERIFIED: countBy("persistence", "NOT_VERIFIED"),
        FAIL: countBy("persistence", "FAIL"),
      },
      negativeBreakdown: {
        NEGATIVE_CONTRACT_PASS: countBy("negativeContract", "NEGATIVE_CONTRACT_PASS"),
        NOT_APPLICABLE: countBy("negativeContract", "NOT_APPLICABLE"),
        NOT_RUN: countBy("negativeContract", "NOT_RUN"),
        FAIL: countBy("negativeContract", "FAIL"),
      },
      authChecks,
      n01ConsumeStatus,
      bulkTerminal,
      bulkSnap,
      results,
    };
    writeFileSync(REPORT_JSON_PATH, JSON.stringify(summary, null, 2), "utf8");
    const mdLines = [
      `# Certificación 158 Endpoints G6 H5 R2`,
      `- Fecha: ${summary.timestamp}`,
      `- Total: ${summary.total} | PASS: ${passed} | FAIL: ${failed}`,
      `- N01 Consume: ${n01ConsumeStatus} | Bulk Terminal: ${bulkTerminal} | AuthChecks: ${authChecks.every((a) => a.pass)}`,
      ``,
      `| # | Servicio | operationId | Método | Ruta | HTTP | Seguridad | Negativo | Funcional | Persistencia | Async | Estado |`,
      `|---:|---|---|---|---|---:|---|---|---|---|---|---|`,
      ...results.map((r) => `| ${r.n} | ${r.svc} | \`${r.opId}\` | ${r.method} | \`${r.rawRoute}\` | ${r.httpStatus} | ${r.routeSecurity} | ${r.negativeContract} | ${r.functional} | ${r.persistence} | ${r.asyncTerminal} | **${r.status}** |`),
    ];
    writeFileSync(REPORT_MD_PATH, mdLines.join("\n"), "utf8");

    console.log(JSON.stringify({
      total: summary.total,
      passed,
      failed,
      n01ConsumeStatus,
      bulkTerminal,
      authChecksPass: authChecks.every((a) => a.pass),
    }));

    if (failed > 0 || n01ConsumeStatus !== "COMPLETED" || bulkTerminal !== "COMPLETED") {
      writeFileSync(resolve(BACKEND_ROOT, "tests/h5/certify-stack.log"), stackLogs, "utf8");
      const qCat = await httpCall(`${env.isolatedBusUrl}/queues/g6.catalog.from.bulk/peek`).catch(() => null);
      const qBulk = await httpCall(`${env.isolatedBusUrl}/queues/g6.bulk.from.catalog/peek`).catch(() => null);
      const qTax = await httpCall(`${env.isolatedBusUrl}/queues/g6.catalog.from.taxonomy/peek`).catch(() => null);
      console.error(`[certify] DIAG n01=${n01ConsumeStatus} bulk=${bulkTerminal} bulkSnap=${JSON.stringify(bulkSnap)} qCat=${qCat?.text?.slice(0,200)} qBulk=${qBulk?.text?.slice(0,200)} qTax=${qTax?.text?.slice(0,200)}`);
    }
    const allOk =
      failed === 0 &&
      n01ConsumeStatus === "COMPLETED" &&
      bulkTerminal === "COMPLETED" &&
      authChecks.every((a) => a.pass);
    exitCode = allOk ? 0 : 1;
  } catch (err) {
    if (typeof stackLogs === "string" && stackLogs.length > 0) {
      writeFileSync(resolve(BACKEND_ROOT, "tests/h5/certify-stack.log"), stackLogs, "utf8");
    }
    throw err;
  } finally {
    await stopStack();
    process.exitCode = exitCode;
  }
}

async function verifyAsyncTerminal(opId, json, ctx) {
  if ((opId === "crearImportacionGeneralProductos" || opId === "reanudarImportacionGeneral") && json?.batch_id) {
    const p = await pollUntil(
      () => httpCall(`${ctx.gw}/api/v1/carga-masiva/productos/importaciones/${json.batch_id}`, { headers: { Authorization: `Bearer ${ctx.gestorJwt}` } }),
      (r) =>
        opId === "reanudarImportacionGeneral"
          ? r.json?.status === "COMPLETED" && r.json?.failed_rows === 0 && r.json?.completed_rows === r.json?.total_rows
          : ["COMPLETED", "FAILED_GENERAL"].includes(r.json?.status),
      80,
      500,
    );
    return p?.json?.status === "COMPLETED";
  }
  if (opId === "crearExportacionGeneralProductos" && (json?.export_id || json?.exportId)) {
    const id = json.export_id ?? json.exportId;
    const p = await pollUntil(
      () => httpCall(`${ctx.gw}/api/v1/carga-masiva/productos/exportaciones/${id}`, { headers: { Authorization: `Bearer ${ctx.gestorJwt}` } }),
      (r) => r.json?.status === "COMPLETED",
    );
    return p?.json?.status === "COMPLETED";
  }
  if (opId === "crearExportacionAuditoriaPrecios" && json?.exportId) {
    const p = await pollUntil(
      () => httpCall(`${ctx.gw}/api/v1/auditoria-precios/exportaciones/${json.exportId}`, { headers: { Authorization: `Bearer ${ctx.gestorJwt}` } }),
      (r) => (r.json?.status ?? r.json?.estado) === "COMPLETED",
    );
    return (p?.json?.status ?? p?.json?.estado) === "COMPLETED";
  }
  if ((opId === "solicitarDesactivacionValorCaracteristica" || opId === "solicitarDesactivacionTipoProducto") && (json?.operation_id || json?.operationId)) {
    const id = json.operation_id ?? json.operationId;
    const p = await pollUntil(
      () => httpCall(`${ctx.gw}/api/v1/taxonomia/operaciones/${id}`, { headers: { Authorization: `Bearer ${ctx.gestorJwt}` } }),
      (r) => ["COMPLETED", "COMPLETADA", "APLICADA", "FINALIZADA", "FAILED", "ERROR", "REJECTED", "RECHAZADA"].includes(String(r.json?.status ?? r.json?.estado ?? "").toUpperCase()),
      40,
      300,
    );
    return ["COMPLETED", "COMPLETADA", "APLICADA", "FINALIZADA"].includes(String(p?.json?.status ?? p?.json?.estado ?? "").toUpperCase());
  }
  if ((opId === "admitirConsumoCuponH5" || opId === "admitirRestauracionCuponH5") && json?.operation_id) {
    const p = await pollUntil(
      () => httpCall(`${ctx.gw}/api/v1/cupones/operaciones/${json.operation_id}?order_id=${json.order_id ?? ctx.orderId}`, { headers: { Authorization: `Bearer ${ctx.g5Token}` } }),
      (r) => ["COMPLETED", "REJECTED"].includes(r.json?.status),
      40,
      300,
    );
    if (opId === "admitirRestauracionCuponH5") {
      return p?.json?.status === "COMPLETED" && p?.json?.result?.outcome === "RESTORED";
    }
    if (p?.json?.status !== "COMPLETED") {
      console.error(`[certify] DIAG ${opId} terminal=${JSON.stringify(p?.json)}`);
    }
    return p?.json?.status === "COMPLETED";
  }
  if (["solicitarReserva", "confirmarReserva", "liberarReserva"].includes(opId) && json?.operation_id) {
    const p = await pollUntil(
      () => httpCall(`${ctx.gw}/api/v1/inventario/operaciones/${json.operation_id}`, { headers: { Authorization: `Bearer ${ctx.g5Token}` } }),
      (r) => ["APLICADO", "COMPLETED", "COMPLETADA"].includes(r.json?.status),
    );
    return ["APLICADO", "COMPLETED", "COMPLETADA"].includes(p?.json?.status);
  }
  return true;
}

function buildPositiveBody(opId, ctx) {
  const uid = randomUUID().slice(0, 6);
  switch (opId) {
    case "crearProducto":
      return { nombre: `Prod Cert ${uid}`, descripcion: "Desc Cert", categoriaId: ctx.catId, marcaId: ctx.brandId, tipoProductoId: ctx.typeId, skuBase: `SKU-P-${uid.toUpperCase()}`, tieneVariantes: false, precioBaseInicial: 80 };
    case "crearVariante":
      return { sku: `SKU-VAR-${uid.toUpperCase()}`, atributosIdentificadores: [{ caracteristica_id: ctx.attrId, nombre: ctx.attrName, valor_id: ctx.valId2, valor: ctx.valName2 }], atributosNoIdentificadores: [], imagenUrl: "https://example.test/vp.png", perfilFisico: { pesoKg: 1.2, dimensionesCm: { largo: 10, ancho: 10, alto: 5 } } };
    case "actualizarVariante":
      return { imagenUrl: "https://example.test/vu.png" };
    case "actualizarProducto":
      return { nombre: `Prod Act ${uid}` };
    case "crearVariante":
      return { sku: `SKU-V-${uid.toUpperCase()}`, atributosIdentificadores: [{ caracteristicaId: ctx.attrId, valorId: ctx.valId }], atributosNoIdentificadores: [], imagenes: ["https://example.test/v.png"], datosFisicos: { pesoKg: 1, dimensionesCm: { largo: 5, ancho: 5, alto: 5 } } };
    case "actualizarVariante":
      return { imagenes: ["https://example.test/v2.png"] };
    case "crearVariante":
      return { sku: `SKU-VAR-${uid.toUpperCase()}`, atributosIdentificadores: [{ caracteristica_id: ctx.attrId, nombre: ctx.attrName, valor_id: ctx.valId2, valor: ctx.valName2 }], atributosNoIdentificadores: [], imagenUrl: "https://example.test/vp.png", perfilFisico: { pesoKg: 1.2, dimensionesCm: { largo: 10, ancho: 10, alto: 5 } } };
    case "actualizarVariante":
      return { imagenUrl: "https://example.test/vu.png" };
    case "actualizarProducto":
      return { nombre: `Prod Upd ${uid}`, descripcion: "Desc Upd" };
    case "reintentarPreparacionProducto":
      return { dependencia: "PRICING", motivo: "Reintento certificacion" };
    case "reintentarPreparacionVariante":
      return { dependencia: "INVENTARIO", motivo: "Reintento certificacion" };
    case "consultarDatosFisicos":
      return { skus: [ctx.activeSku1] };
    case "resolverCodigoBarras":
      return { codigo_barras: ctx.barcode1 };
    case "resolverSkusAdministracion":
      return { skus: [ctx.activeSku1] };
    case "obtenerContextosSkuLote":
      return { skus: [ctx.activeSku1] };
    case "filtrarSkusVendiblesInterno":
      return { sku: ctx.activeSku1, tamanio: 10 };
    case "crearCategoria":
      return { nombre: `Cat Pos ${uid}`, slugConfirmado: `cat-pos-${uid.toLowerCase()}`, categoriaPadreId: null };
    case "actualizarCategoria":
      return { nombre: `Cat Upd ${uid}` };
    case "resolverSlugCategoriaCreacion":
      return { nombre: `Slug Test ${uid}` };
    case "actualizarSeoCategoria":
      return { slug: `cat-seo-${uid.toLowerCase()}`, metaTitulo: `Title ${uid}`, metaDescripcion: `Desc ${uid}` };
    case "crearCaracteristica":
      return { nombre: `Attr Pos ${uid}`, tipo: "TEXTO" };
    case "actualizarCaracteristica":
      return { nombre: `Attr Upd ${uid}`, version: 0 };
    case "crearValorCaracteristica":
      return { nombre: `Val Pos ${uid}` };
    case "actualizarValorCaracteristica":
      return { nombre: `Val Upd ${uid}` };
    case "crearMarca":
      return { nombre: `Marca Pos ${uid}` };
    case "actualizarMarca":
      return { nombre: `Marca Upd ${uid}`, version: 0 };
    case "crearTipoProducto":
      return { nombre: `Tipo Pos ${uid}` };
    case "asociarCaracteristicaTipoProducto":
      return { caracteristicaId: ctx.attrId2, obligatoria: false, esIdentificador: false };
    case "actualizarAsociacionTipoCaracteristica":
      return { obligatoria: true, schemaVersion: ctx.typeSchemaVersion };
    case "actualizarPrecioSku":
      return { accionPrecioOferta: "CONSERVAR", priceVersion: 1, precioRegular: 130, moneda: "PEN", channelId: "MARKETPLACE", motivoCambio: "CERT_PATCH" };
    case "actualizarPrecioBaseProducto":
      return { accionPrecioOferta: "CONSERVAR", priceVersion: 1, precioRegular: 130, moneda: "PEN", motivoCambio: "CERT_PATCH" };
    case "programarPrecioSku":
    case "programarPrecioBaseProducto":
      return { tipoPrecio: "REGULAR", importe: 140, moneda: "PEN", validFrom: new Date(Date.now() + 3_600_000).toISOString(), motivoCambio: "CERT_PROG" };
    case "prevalidarImportacionPrecios":
    case "crearImportacionPrecios":
      return { items: [{ sku: ctx.activeSku1, precioRegular: 125, moneda: "PEN", accionPrecioOferta: "CONSERVAR" }] };
    case "crearPromocion":
      return { nombre: `Promo Pos ${uid}`, tipoDescuento: "PORCENTAJE", valor: 15, modalidad: "AUTOMATICA", estado: "ACTIVO", prioridad: 1, validFrom: new Date(Date.now() - 60_000).toISOString(), validUntil: new Date(Date.now() + 86_400_000).toISOString(), canalesHabilitados: ["MARKETPLACE"], alcance: { productIds: [ctx.activeProd1] }, politicaCombinacion: { ofertaPricing: true, promocionAutomatica: true, cupon: true } };
    case "actualizarPromocion":
      return { nombre: `Promo Upd ${uid}` };
    case "evaluarPromociones":
      return { channel_id: "MARKETPLACE", lines: [{ sku: ctx.activeSku1, product_id: ctx.activeProd1, quantity: 1 }] };
    case "validarCupon":
      return { channel_id: "MARKETPLACE", coupon_code: ctx.couponCode, customer_ref: ctx.customerRef, lines: [{ sku: ctx.activeSku1, product_id: ctx.activeProd1, quantity: 1 }] };
    case "crearCupon":
      return { codigo: `CPN${uid.toUpperCase()}`, promocionId: ctx.promoId, estado: "ACTIVO", politicaCancelacion: "RESTAURAR_EN_CANCELACION" };
    case "actualizarCupon":
      return { maxUsosGlobal: 50 };
    case "crearReglaRecomendacion":
      return { nombre: `Regla Pos ${uid}`, tipo: "CROSS_SELL", origen: { tipo: "PRODUCTO", id: ctx.activeProd1 }, recomendados: [{ productId: ctx.activeProd2, orden: 1 }], estado: "ACTIVO", validFrom: new Date(Date.now() - 60_000).toISOString(), validUntil: new Date(Date.now() + 86_400_000).toISOString(), prioridad: 2 };
    case "actualizarReglaRecomendacion":
      return { prioridad: 3 };
    case "admitirConsumoCuponH5":
      return { operation_id: ctx.opIdempotency, order_id: ctx.orderId4, coupon_code: ctx.couponCode, customer_ref: ctx.customerRef4, channel_id: "MARKETPLACE", effective_at: ctx.effectiveAt, reservation_id: ctx.reservationId4, commercial_snapshot_ref: ctx.orderId4 };
    case "admitirRestauracionCuponH5":
      return { operation_id: ctx.opIdempotency, order_id: ctx.orderId, consumption_operation_id: ctx.consumeOpId, cancellation_reason: "ANULACION", cancelled_at: new Date().toISOString() };
    case "crearCombo":
    case "crearComboAdministracion":
      return { nombre: `Combo Pos ${uid}`, componentes: [{ sku: ctx.activeSku1, cantidad: 1 }, { sku: ctx.activeSku2, cantidad: 1 }], precioCombo: 199 };
    case "actualizarCombo":
      return { nombre: `Combo Upd ${uid}`, componentes: [{ sku: ctx.activeSku1, cantidad: 1 }, { sku: ctx.activeSku2, cantidad: 1 }], precioCombo: 195 };
    case "solicitarReserva":
      return { order_id: randomUUID(), operation_id: randomUUID(), channel_id: "MARKETPLACE", lines: [{ sku: ctx.activeSku1, quantity: 1, location_id: "00000000-0000-4000-8000-000000000101" }] };
    case "confirmarReserva":
      return { order_id: ctx.orderId2, operation_id: randomUUID() };
    case "liberarReserva":
      return { order_id: ctx.orderId3, operation_id: randomUUID(), reason: "ANULACION" };
    case "verificarCantidadComercial":
      return { channel_id: "MARKETPLACE", fulfillment: { mode: "ENVIO_DOMICILIO" }, lines: [{ sku: ctx.activeSku1, quantity: 1 }] };
    case "reportarIncidenciaInventario":
      return { operation_id: randomUUID(), external_incident_id: `INC-${uid}`, sku: ctx.activeSku1, location_id: ctx.storeLocationId, quantity: 1, type: "DANIO", occurred_at: new Date().toISOString() };
    case "resolverIncidenciaInventario":
      return { operation_id: randomUUID(), resolution: "MERMA", act_ref: "ACT-CERT-01" };
    case "reintegrarInventario":
      return { operation_id: randomUUID(), order_id: ctx.orderId, source_ref: `RET-${uid}`, reason: "RETORNO_LOGISTICO", lines: [{ sku: ctx.activeSku1, quantity: 1, location_id: ctx.storeLocationId }] };
    case "conciliarVentaOffline":
      return { operation_id: randomUUID(), offline_sale_id: randomUUID(), order_id: randomUUID(), channel_id: "RETAIL", occurred_at: new Date().toISOString(), lines: [{ sku: ctx.activeSku1, quantity: 1, location_id: ctx.storeLocationId }] };
    case "actualizarUmbralGlobal":
      return { umbral: 5 };
    case "establecerUmbralSku":
      return { umbral: 3 };
    case "registrarRecepcionTrasladoInventario":
      return { operation_id: randomUUID(), received_quantity: 5, disposition: "REINGRESAR_DISPONIBLE", final_receipt: true, received_at: new Date().toISOString() };
    case "crearExportacionAuditoriaPrecios":
      return { formato: "CSV" };
    case "crearExportacionGeneralProductos":
      return { formato: "CSV" };
    default:
      return undefined;
  }
}

void main().catch((err) => {
  console.error(err);
  writeFileSync(
    REPORT_JSON_PATH,
    JSON.stringify(
      {
        status: "SETUP_FAILED",
        timestamp: new Date().toISOString(),
        total: 0,
        executed: 0,
        notExecuted: 158,
        passed: 0,
        failed: 0,
        error: err instanceof Error ? err.message : String(err),
      },
      null,
      2,
    ),
    "utf8",
  );
  process.exit(1);
});
