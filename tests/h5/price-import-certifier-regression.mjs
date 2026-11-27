import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import test from "node:test";
import {
  formatAsyncTerminalStatus,
  verifyAsyncTerminal,
} from "./certify-158-endpoints.mjs";

function startMockGateway(handler) {
  return new Promise((resolveServer) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      const result = handler(req.method, url.pathname, req.headers);
      res.writeHead(result.status ?? 200, {
        "content-type": "application/json",
      });
      res.end(JSON.stringify(result.body));
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolveServer({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

test("HTTP 202 crearImportacionPrecios ending FAILED (SKU sin precio) produces ASYNC_TERMINAL_FAIL and overall FAIL", async () => {
  const batchId = randomUUID();
  const gw = await startMockGateway((_method, pathname) => {
    assert.equal(pathname, `/api/v1/precios/importaciones/${batchId}`);
    return {
      status: 200,
      body: {
        batch_id: batchId,
        status: "FAILED",
        allow_partial: false,
        total_rows: 1,
        completed_rows: 0,
        failed_rows: 1,
        rows: [
          {
            row_id: "2",
            sku: "SKU-SIN-PRECIO-001",
            status: "FAILED",
            code: "PRECIO_NO_ENCONTRADO",
          },
        ],
      },
    };
  });
  try {
    const asyncTerminalPass = await verifyAsyncTerminal(
      "crearImportacionPrecios",
      { batch_id: batchId, status: "QUEUED" },
      { gw: gw.url, gestorJwt: "test-jwt" },
    );
    assert.equal(asyncTerminalPass, false);
    const asyncTerminalLabel = formatAsyncTerminalStatus(202, asyncTerminalPass);
    assert.equal(asyncTerminalLabel, "ASYNC_TERMINAL_FAIL");
    assert.notEqual(asyncTerminalLabel, "ASYNC_TERMINAL_PASS");
    const overallPass = true && asyncTerminalPass;
    assert.equal(overallPass, false);
  } finally {
    await gw.close();
  }
});

test("HTTP 202 crearImportacionPrecios ending PARTIAL produces ASYNC_TERMINAL_FAIL and overall FAIL", async () => {
  const batchId = randomUUID();
  const gw = await startMockGateway(() => ({
    status: 200,
    body: {
      batch_id: batchId,
      status: "PARTIAL",
      allow_partial: true,
      total_rows: 2,
      completed_rows: 1,
      failed_rows: 1,
      rows: [
        { row_id: "2", sku: "SKU-OK", status: "COMPLETED" },
        { row_id: "3", sku: "SKU-FAIL", status: "FAILED", code: "PRECIO_NO_ENCONTRADO" },
      ],
    },
  }));
  try {
    const asyncTerminalPass = await verifyAsyncTerminal(
      "crearImportacionPrecios",
      { batch_id: batchId, status: "QUEUED" },
      { gw: gw.url, gestorJwt: "test-jwt" },
    );
    assert.equal(asyncTerminalPass, false);
    assert.equal(formatAsyncTerminalStatus(202, asyncTerminalPass), "ASYNC_TERMINAL_FAIL");
  } finally {
    await gw.close();
  }
});

test("HTTP 202 crearImportacionPrecios missing batch_id produces ASYNC_TERMINAL_FAIL", async () => {
  const asyncTerminalPass = await verifyAsyncTerminal(
    "crearImportacionPrecios",
    { status: "QUEUED" },
    { gw: "http://127.0.0.1:1", gestorJwt: "test-jwt" },
  );
  assert.equal(asyncTerminalPass, false);
  assert.equal(formatAsyncTerminalStatus(202, asyncTerminalPass), "ASYNC_TERMINAL_FAIL");
});

test("HTTP 202 crearImportacionPrecios ending COMPLETED with 0 failures produces ASYNC_TERMINAL_PASS", async () => {
  const batchId = randomUUID();
  const gw = await startMockGateway(() => ({
    status: 200,
    body: {
      batch_id: batchId,
      status: "COMPLETED",
      allow_partial: false,
      total_rows: 1,
      completed_rows: 1,
      failed_rows: 0,
      rows: [
        { row_id: "2", sku: "SKU-IMP-PRECIO-OK", status: "COMPLETED" },
      ],
    },
  }));
  try {
    const asyncTerminalPass = await verifyAsyncTerminal(
      "crearImportacionPrecios",
      { batch_id: batchId, status: "QUEUED" },
      { gw: gw.url, gestorJwt: "test-jwt" },
    );
    assert.equal(asyncTerminalPass, true);
    assert.equal(formatAsyncTerminalStatus(202, asyncTerminalPass), "ASYNC_TERMINAL_PASS");
  } finally {
    await gw.close();
  }
});
