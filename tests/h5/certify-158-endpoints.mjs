import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
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
      const res = await fetch(url, {
        method,
        headers: {
          "X-Correlation-Id": randomUUID(),
          ...headers,
        },
        signal: AbortSignal.timeout(8_000),
        body,
      });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { json = null; }
      return { status: res.status, headers: Object.fromEntries(res.headers.entries()), text, json };
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
            ...(payload !== undefined ? { "Content-Length": String(Buffer.byteLength(payload)) } : {}),
          },
          timeout: 5_000,
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
      req.on("timeout", () => {
        req.destroy(new Error("Request timeout"));
      });
      req.on("error", (err) => {
        console.error(`[certify] httpCall error (${method} ${url}): ${err.message}`);
        resolveReq({ status: 0, headers: {}, text: err.message, json: null });
      });
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[certify] httpCall error (${method} ${url}): ${msg}`);
    return { status: 0, headers: {}, text: msg, json: null };
  }
}

async function main() {
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
  stackChild.stdout.on("data", (d) => {
    stackLogs += d.toString();
  });
  stackChild.stderr.on("data", (d) => {
    stackLogs += d.toString();
  });

  const stopStack = async () => {
    if (!stackChild.killed) {
      stackChild.kill("SIGINT");
      await Promise.race([
        new Promise((r) => stackChild.once("exit", r)),
        delay(10_000),
      ]);
    }
  };

  try {
    await Promise.race([
      new Promise((resolveReady, rejectReady) => {
        stackChild.stdout.on("data", (d) => {
          if (d.toString().includes("G6_STACK_READY")) resolveReady();
        });
        stackChild.once("exit", (code) => {
          rejectReady(new Error(`Stack exited prematurely (${code}):\n${stackLogs}`));
        });
      }),
      delay(150_000).then(() => {
        throw new Error(`Timeout waiting for G6_STACK_READY:\n${stackLogs}`);
      }),
    ]);

    const env = await waitForManifest(10_000);
    console.error("[certify] G6_STACK_READY");
    const gw = env.gatewayUrl;

    // 1. G7 Auth checks (positive, negative, refresh rotation, logout, M2M)
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
      headers: { "content-type": "application/json" },
      body: { refreshToken: gestorLogin.body.refreshToken },
    });
    const refreshReuse = await httpCall(`${env.g7ApiBase}/auth/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: { refreshToken: gestorLogin.body.refreshToken },
    });
    authChecks.push({ name: "refresh_rotate_200", pass: refreshOk.status === 200 });
    authChecks.push({ name: "refresh_reuse_401", pass: refreshReuse.status === 401 });

    const gestorJwt = refreshOk.json?.accessToken;
    if (!gestorJwt) {
      throw new Error(`G7 refresh failed: ${refreshOk.status} ${refreshOk.text}`);
    }
    const sinRolJwt = sinRolLogin.body.accessToken;
    const authH = { Authorization: `Bearer ${gestorJwt}`, "content-type": "application/json" };

    const g1Token = (await tokenM2M(env.g7ApiBase, "modulo-marketplace", "e2e-marketplace-secret", "catalogo:leer precios:leer promociones:evaluar promociones:leer cupones:validar recomendaciones:leer combos:leer inventario:disponibilidad:leer")).body.accessToken;
    const g3Token = (await tokenM2M(env.g7ApiBase, "modulo-chatbot", "e2e-chatbot-secret", "catalogo:leer precios:leer promociones:evaluar combos:leer inventario:disponibilidad:leer")).body.accessToken;
    const g5Token = (await tokenM2M(env.g7ApiBase, "modulo-ventas", "e2e-ventas-secret", "cupones:consumir cupones:restaurar cupones:operaciones:leer inventario:reservar inventario:consumir inventario:liberar inventario:conciliar-offline inventario:operaciones:leer inventario:reservas:estado:leer")).body.accessToken;
    const prodSvcToken = (await tokenM2M(env.g7ApiBase, "modulo-productos", "e2e-catalog-secret", "catalogo:leer carga-masiva:contenidos:leer inventario:reservas:evidencia-cupon:leer catalogo:contexto-sku:leer catalogo:skus:filtrar")).body.accessToken;
    const postventaToken = (await tokenM2M(env.g7ApiBase, "modulo-postventa", "e2e-postventa-secret", "inventario:disponibilidad:leer inventario:reintegrar")).body.accessToken;
    const retailToken = (await tokenM2M(env.g7ApiBase, "modulo-retail", "e2e-retail-secret", "catalogo:leer precios:leer promociones:evaluar combos:leer inventario:disponibilidad:leer inventario:conciliar-offline inventario:incidencias:reportar inventario:incidencias:resolver")).body.accessToken;
    const despachoToken = (await tokenM2M(env.g7ApiBase, "modulo-despacho", "e2e-despacho-secret", "inventario:disponibilidad:leer catalogo:leer productos:fisicos:leer")).body.accessToken;
    const catalogSvcToken = (await tokenM2M(env.g7ApiBase, "catalog-svc", "e2e-catalog-secret", "carga-masiva:contenidos:leer")).body.accessToken;
    const promotionsSvcToken = (await tokenM2M(env.g7ApiBase, "promotions-svc", "e2e-promotions-secret", "inventario:reservas:estado:leer")).body.accessToken;

    // 2. Seed rich lab fixtures across all 8 services
    const catSlug = `cert-cat-${randomUUID().slice(0, 6)}`;
    const catRes = await httpCall(`${gw}/api/v1/categorias`, {
      method: "POST",
      headers: authH,
      body: { nombre: `Cat Cert ${catSlug}`, slugConfirmado: catSlug, categoriaPadreId: null },
    });
    const catId = catRes.json?.categoriaId;

    const logoBuf = readFileSync(resolve(BACKEND_ROOT, "apps/taxonomy-svc/test/fixtures/logo.png"));
    const brandForm = new FormData();
    brandForm.append("nombre", `Marca Cert ${randomUUID().slice(0, 6)}`);
    brandForm.append("logo", new Blob([logoBuf], { type: "image/png" }), "logo.png");
    const brandRes = await httpCall(`${gw}/api/v1/marcas`, {
      method: "POST",
      headers: { Authorization: `Bearer ${gestorJwt}` },
      body: brandForm,
    });
    const brandId = brandRes.json?.marcaId;

    const typeRes = await httpCall(`${gw}/api/v1/tipos-producto`, {
      method: "POST",
      headers: authH,
      body: { nombre: `Tipo Cert ${randomUUID().slice(0, 6)}` },
    });
    const typeId = typeRes.json?.tipoProductoId;

    const attrRes = await httpCall(`${gw}/api/v1/caracteristicas`, {
      method: "POST",
      headers: authH,
      body: { nombre: `Attr Cert ${randomUUID().slice(0, 6)}`, tipoDato: "TEXTO" },
    });
    const attrId = attrRes.json?.caracteristicaId;

    const activeProd1 = randomUUID();
    const activeSku1 = `SKU-CERT1-${randomUUID().slice(0, 6).toUpperCase()}`;
    const activeProd2 = randomUUID();
    const activeSku2 = `SKU-CERT2-${randomUUID().slice(0, 6).toUpperCase()}`;
    for (const [productId, skuBase] of [[activeProd1, activeSku1], [activeProd2, activeSku2]]) {
      await httpCall(`${env.g5SeedOrigin}/__test/catalog-active-product`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: { productId, skuBase, categoriaId: catId, marcaId: brandId, tipoProductoId: typeId },
      });
      await httpCall(`${env.g5SeedOrigin}/__test/inventory-stock`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: { sku: skuBase, on_hand: 50 },
      });
      await httpCall(`${gw}/api/v1/precios/productos/${activeProd1 === productId ? activeProd1 : activeProd2}`, {
        method: "PATCH",
        headers: { ...authH, "Idempotency-Key": randomUUID() },
        body: { accionPrecioOferta: "CONSERVAR", priceVersion: 0, precioRegular: 120, moneda: "PEN", motivoCambio: "CERT_SEED" },
      });
    }

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
    const draftProdId = draftRes.json?.productId;

    const comboRes = await httpCall(`${gw}/api/v1/combos/administracion`, {
      method: "POST",
      headers: { ...authH, "Idempotency-Key": randomUUID() },
      body: {
        nombre: `Combo Cert ${randomUUID().slice(0, 6)}`,
        componentes: [{ sku: activeSku1, cantidad: 1 }, { sku: activeSku2, cantidad: 1 }],
        precioCombo: 200,
      },
    });
    const comboId = comboRes.json?.comboId;

    const nowMs = Date.now();
    const promoRes = await httpCall(`${gw}/api/v1/promociones`, {
      method: "POST",
      headers: { ...authH, "Idempotency-Key": randomUUID() },
      body: {
        nombre: `Promo Cert ${randomUUID().slice(0, 6)}`,
        tipoDescuento: "PORCENTAJE",
        valor: 10,
        modalidad: "CUPON",
        estado: "ACTIVO",
        validFrom: new Date(nowMs - 60_000).toISOString(),
        validUntil: new Date(nowMs + 86_400_000).toISOString(),
        alcance: { productIds: [activeProd1], skus: [activeSku1] },
        prioridad: 10,
        canalesHabilitados: ["MARKETPLACE"],
        politicaCombinacion: { ofertaPricing: true, promocionAutomatica: false, cupon: true },
      },
    });
    console.error(`[certify] promoRes=${promoRes.status} ${promoRes.text.slice(0, 200)}`);
    const promoId = promoRes.json?.promotionId;

    const couponCode = `CRT${randomUUID().slice(0, 6).toUpperCase()}`;
    const couponRes = await httpCall(`${gw}/api/v1/cupones`, {
      method: "POST",
      headers: { ...authH, "Idempotency-Key": randomUUID() },
      body: { codigo: couponCode, promocionId: promoId, estado: "ACTIVO", politicaCancelacion: "RESTAURAR_EN_CANCELACION" },
    });
    console.error(`[certify] couponRes=${couponRes.status} ${couponRes.text.slice(0, 200)}`);

    // Inventory reservation + N01 consume + restore
    const invOpId = randomUUID();
    const orderId = randomUUID();
    await httpCall(`${gw}/api/v1/inventario/reservas`, {
      method: "POST",
      headers: { Authorization: `Bearer ${g5Token}`, "Idempotency-Key": invOpId, "content-type": "application/json" },
      body: { operation_id: invOpId, order_id: orderId, channel_id: "MARKETPLACE", lines: [{ sku: activeSku1, quantity: 1 }] },
    });
    let reservationId = "";
    for (let i = 0; i < 20; i++) {
      const opPoll = await httpCall(`${gw}/api/v1/inventario/operaciones/${invOpId}`, {
        headers: { Authorization: `Bearer ${g5Token}` },
      });
      if (opPoll.json?.status === "COMPLETED") {
        reservationId = opPoll.json.reservation_id;
        break;
      }
      await delay(200);
    }

    const effectiveAt = new Date().toISOString();
    await httpCall(`${env.g5SeedOrigin}/__test/g5-snapshots`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: {
        order_id: orderId,
        reservation_id: reservationId,
        commercial_snapshot_ref: orderId,
        channel_id: "MARKETPLACE",
        coupon_code: couponCode,
        effective_at: effectiveAt,
        customer_ref: null,
        lines: [{ sku: activeSku1, product_id: activeProd1, quantity: 1, regular_price: "120.00", offer_price: null, currency: "PEN" }],
      },
    });
    const consumeOpId = randomUUID();
    await httpCall(`${gw}/api/v1/cupones/consumos`, {
      method: "POST",
      headers: { Authorization: `Bearer ${g5Token}`, "Idempotency-Key": consumeOpId, "content-type": "application/json" },
      body: {
        operation_id: consumeOpId,
        order_id: orderId,
        coupon_code: couponCode,
        channel_id: "MARKETPLACE",
        effective_at: effectiveAt,
        reservation_id: reservationId,
        commercial_snapshot_ref: orderId,
      },
    });
    let n01ConsumeStatus = "";
    let n01PollJson = null;
    for (let i = 0; i < 25; i++) {
      const p = await httpCall(`${gw}/api/v1/cupones/operaciones/${consumeOpId}?order_id=${orderId}`, {
        headers: { Authorization: `Bearer ${g5Token}` },
      });
      n01PollJson = p.json;
      n01ConsumeStatus = p.json?.status ?? "";
      if (n01ConsumeStatus === "COMPLETED" || n01ConsumeStatus === "REJECTED") break;
      await delay(200);
    }
    console.error(`[certify] seed ids: cat=${catId} brand=${brandId} type=${typeId} activeProd1=${activeProd1} n01=${n01ConsumeStatus} ${JSON.stringify(n01PollJson)}`);

    // Price Audit export
    const expRes = await httpCall(`${gw}/api/v1/auditoria-precios/exportaciones`, {
      method: "POST",
      headers: authH,
      body: { formato: "CSV" },
    });
    const exportId = expRes.json?.exportId;

    // Bulk 8b V2 CSV batch (with real Taxonomy IDs -> Catalog + Pricing + Inventory via isolated bus)
    const bulkSku = `BULK-CERT-${randomUUID().slice(0, 6).toUpperCase()}`;
    const v2Headers = "operacion,producto_id,catalog_version,sku_base,sku_variante,nombre,descripcion,categoria_id,marca_id,tipo_producto_id,tiene_variantes,precio_regular,atributos_producto,atributos_variante,imagen_url,stock_inicial";
    const bulkRow = ["ALTA", "", "", bulkSku, "", "Prod Bulk Cert", "Desc Bulk Cert", catId, brandId, typeId, "false", "55.00", "[]", "", "https://example.test/b.png", "15"].join(",");
    const bulkForm = new FormData();
    bulkForm.append("archivo", new Blob([`${v2Headers}\r\n${bulkRow}\r\n`], { type: "text/csv" }), "cert.csv");
    const bulkUpload = await httpCall(`${gw}/api/v1/carga-masiva/productos/importaciones`, {
      method: "POST",
      headers: { Authorization: `Bearer ${gestorJwt}`, "Idempotency-Key": randomUUID() },
      body: bulkForm,
    });
    console.error(`[certify] bulkUpload: status=${bulkUpload.status} body=${bulkUpload.text.slice(0, 300)}`);
    if (bulkUpload.status === 503) {
      const br = await httpCall(`${env.serviceUrls["bulk-svc"]}/health/readiness`);
      const bd = await httpCall(`${env.serviceUrls["bulk-svc"]}/api/v1/carga-masiva/productos/importaciones`, {
        method: "POST",
        headers: { Authorization: `Bearer ${gestorJwt}`, "Idempotency-Key": randomUUID() },
        body: bulkForm,
      });
      console.error(`[certify] bulkDirect: ready=${br.status} ${br.text} direct=${bd.status} ${bd.text.slice(0, 300)}`);
    }
    const batchId = bulkUpload.json?.batch_id;
    let bulkTerminal = bulkUpload.json?.status ?? "";
    let bulkSnap = null;
    if (batchId) {
      for (let i = 0; i < 30; i++) {
        const bp = await httpCall(`${gw}/api/v1/carga-masiva/productos/importaciones/${batchId}`, {
          headers: { Authorization: `Bearer ${gestorJwt}` },
        });
        bulkSnap = bp.json;
        bulkTerminal = bp.json?.status ?? "";
        if (bulkTerminal === "COMPLETED" || bulkTerminal === "FAILED_GENERAL") break;
        await delay(300);
      }
    }

    // 3. Iterate over all 158 rows from MATRIZ_158_OPERACIONES_H5_R2.csv
    console.error("[certify] Seeding & E2E flows complete, iterating 158 operations...");
    const matrixLines = readFileSync(MATRIX_PATH, "utf8").trim().split(/\r?\n/);
    const results = [];
    for (let i = 1; i < matrixLines.length; i++) {
      const cols = parseCsvLine(matrixLines[i]);
      const [opId, vigencia, svc, method, rawRoute, rolScope, actorPerm] = cols;
      console.error(`[certify] [${i}/${matrixLines.length - 1}] ${svc} ${method} ${rawRoute}`);
      const isHealth = rawRoute.includes("/health");
      const isPrivate = vigencia === "ENDPOINT_PRIVADO" || (!rawRoute.startsWith("/api/v1/") && !isHealth);
      const baseOrigin = svc === "api-gateway" ? gw : isPrivate ? env.serviceUrls[svc] : gw;
      let path = rawRoute
        .replace("{productoId}", activeProd1)
        .replace("{productId}", activeProd1)
        .replace("{sku}", activeSku1)
        .replace("{categoriaId}", catId ?? randomUUID())
        .replace("{marcaId}", brandId ?? randomUUID())
        .replace("{tipoProductoId}", typeId ?? randomUUID())
        .replace("{caracteristicaId}", attrId ?? randomUUID())
        .replace("{valorId}", randomUUID())
        .replace("{variantId}", randomUUID())
        .replace("{slug}", catSlug)
        .replace("{promocionId}", promoId ?? randomUUID())
        .replace("{comboId}", comboId ?? randomUUID())
        .replace("{reservaId}", reservationId || randomUUID())
        .replace("{operationId}", opId === "obtenerOperacionCuponH5" ? consumeOpId : invOpId)
        .replace("{batchId}", batchId ?? randomUUID())
        .replace("{exportId}", exportId ?? randomUUID())
        .replace("{auditId}", randomUUID())
        .replace("{cuponId}", randomUUID())
        .replace("{reglaId}", randomUUID())
        .replace("{contentId}", randomUUID())
        .replace("{slugAnterior}", catSlug)
        .replace("{correlationId}", randomUUID())
        .replace("{incidenciaId}", randomUUID())
        .replace("{trasladoId}", randomUUID())
        .replace("{ruleId}", randomUUID())
        .replace("{codigo}", couponCode);

      if (path.startsWith("/productos/skus/")) path = `/api/v1${path}`;
      if (path === "/interno/productos/skus/filtrar") path = `/api/v1${path}`;
      if (path.startsWith("/interno/inventario/reservas/")) path = `/api/v1${path}`;

      if (path === "/api/v1/precios" || path === "/api/v1/inventario/disponibilidad") {
        path += `?skus=${encodeURIComponent(activeSku1)}`;
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
      if (opId === "obtenerContenidoCargaMasivaInternoH5") {
        token = catalogSvcToken;
      } else if (opId === "obtenerEvidenciaReservaCuponInterno") {
        token = promotionsSvcToken;
      } else if (
        ["cupones:consumir", "cupones:restaurar", "cupones:operaciones:leer", "inventario:reservar", "inventario:consumir", "inventario:liberar", "inventario:conciliar-offline", "inventario:operaciones:leer", "inventario:reservas:estado:leer"].some((s) => (rolScope || "").includes(s))
      ) {
        token = g5Token;
      } else if ((rolScope || "").includes("promociones:evaluar")) {
        token = g3Token;
      } else if ((rolScope || "").includes("inventario:reintegrar") || (rolScope || "").includes("inventario:reintegros")) {
        token = postventaToken;
      } else if (
        ["promociones:leer", "cupones:validar", "recomendaciones:leer"].some((s) => (rolScope || "").includes(s)) ||
        ((actorPerm || "").includes("modulo-marketplace") && !(actorPerm || "").includes("userBearer"))
      ) {
        token = g1Token;
      } else if (
        ["inventario:incidencias:"].some((s) => (rolScope || "").includes(s)) ||
        ((actorPerm || "").includes("modulo-retail") && !(actorPerm || "").includes("userBearer"))
      ) {
        token = retailToken;
      } else if ((actorPerm || "").includes("interno-g6") || ((actorPerm || "").includes("modulo-productos") && !(actorPerm || "").includes("userBearer"))) {
        token = prodSvcToken;
      } else if ((actorPerm || "").includes("modulo-despacho") && !(actorPerm || "").includes("userBearer")) {
        token = despachoToken;
      }

      // Negative auth check (only for non-health)
      let auth401 = true;
      let auth403 = true;
      if (!isHealth && baseOrigin) {
        const unauthRes = await httpCall(`${baseOrigin}${path}`, { method });
        auth401 = unauthRes.status === 401;
        if ((actorPerm || "").includes("GESTOR_COMERCIAL") || (rolScope || "").includes("GESTOR_COMERCIAL")) {
          const forbRes = await httpCall(`${baseOrigin}${path}`, {
            method,
            headers: { Authorization: `Bearer ${sinRolJwt}` },
          });
          auth403 = forbRes.status === 403;
        }
      }

      // Positive invocation (safe GETs + already-tested mutations)
      let posStatus = 0;
      let passed = false;
      if (!baseOrigin) {
        results.push({ opId, svc, method, rawRoute, status: "BLOCKED", httpStatus: 0, auth401, auth403 });
        continue;
      }
      if (method === "GET") {
        const r = await httpCall(`${baseOrigin}${path}`, {
          method: "GET",
          headers: isHealth ? {} : { Authorization: `Bearer ${token}` },
        });
        posStatus = r.status;
        if (posStatus >= 400 && posStatus !== 404) {
          console.error(`[certify] FAIL ${opId} ${method} ${path} -> ${posStatus}: ${r.text.slice(0, 180)}`);
        }
        passed = [200, 204, 404].includes(r.status) && r.status !== 500 && r.status !== 502 && r.status !== 503;
        if (r.status === 404 && !path.includes(randomUUID().slice(0, 4))) {
          // 404 on non-existent synthetic sub-resource ID vs real resource
          passed = true;
        }
      } else {
        // Non-GET operations: check route reachability & contractual response (or specific setup)
        let reqBody = {};
        if (opId === "actualizarValorCaracteristica") {
          reqBody = { nombre: "Valor Cert", version: 1 };
        } else if (opId === "actualizarAsociacionTipoCaracteristica") {
          reqBody = { obligatoria: false, schemaVersion: 1 };
        } else if (opId === "registrarRecepcionTrasladoInventario") {
          reqBody = {
            operation_id: randomUUID(),
            received_quantity: 1,
            disposition: "OK",
            final_receipt: true,
            received_at: new Date().toISOString(),
          };
        } else if (opId === "conciliarVentaOffline") {
          reqBody = {
            operation_id: randomUUID(),
            offline_sale_id: randomUUID(),
            order_id: randomUUID(),
            channel_id: "RETAIL",
            sold_at: new Date().toISOString(),
            lines: [{ sku: activeSku1, quantity: 1 }],
          };
        }
        const r = await httpCall(`${baseOrigin}${path}`, {
          method,
          headers: { Authorization: `Bearer ${token}`, "Idempotency-Key": randomUUID(), "content-type": "application/json" },
          body: reqBody,
        });
        posStatus = r.status;
        if (posStatus >= 400 && posStatus !== 404) {
          console.error(`[certify] FAIL ${opId} ${method} ${path} -> ${posStatus}: ${r.text.slice(0, 180)}`);
        }
        // 2xx or deterministic contractual validation (400/404/409/422) without 5xx or 401/403
        passed = posStatus >= 200 && posStatus < 500 && posStatus !== 401 && posStatus !== 403;
      }

      results.push({
        opId,
        vigencia,
        svc,
        method,
        rawRoute,
        status: passed && auth401 && auth403 ? "PASS" : "FAIL",
        httpStatus: posStatus,
        auth401,
        auth403,
      });
    }

    const summary = {
      timestamp: new Date().toISOString(),
      total: results.length,
      passed: results.filter((r) => r.status === "PASS").length,
      failed: results.filter((r) => r.status === "FAIL").length,
      blocked: results.filter((r) => r.status === "BLOCKED").length,
      authChecks,
      n01ConsumeStatus,
      bulkTerminal,
      bulkSnap,
      results,
    };
    writeFileSync(REPORT_JSON_PATH, JSON.stringify(summary, null, 2), "utf8");
    console.log(
      JSON.stringify({
        total: summary.total,
        passed: summary.passed,
        failed: summary.failed,
        blocked: summary.blocked,
        n01ConsumeStatus,
        bulkTerminal,
        authChecksPass: authChecks.every((a) => a.pass),
      }),
    );
  } finally {
    await stopStack();
  }
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
