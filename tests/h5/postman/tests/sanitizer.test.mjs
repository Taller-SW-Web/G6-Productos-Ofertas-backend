import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSanitizedJunitXml,
  containsSensitiveLeak,
  sanitizeErrorMessage,
  sanitizeNewmanRun,
} from '../scripts/lib/sanitizer-core.mjs';

const SYNTHETIC_JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ0ZXN0LXVzZXIifQ.syntheticSignature123456';
const SYNTHETIC_SECRET = 'synth-client-secret-998877';

test('H09: sanitizeErrorMessage elimina cuerpos privados multilinea y correos en excepciones', () => {
  const rawErr = `Unexpected token '<' at 1:1\n{"email":"privado@empresa.pe","secret":"${SYNTHETIC_SECRET}"}\n^`;
  const clean = sanitizeErrorMessage(rawErr, [SYNTHETIC_SECRET]);
  assert.equal(clean.includes('privado@empresa.pe'), false);
  assert.equal(clean.includes(SYNTHETIC_SECRET), false);
  assert.equal(clean.includes('\n'), false);
});

test('H11: sanitizeNewmanRun separa solicitudes HTTP auxiliares de casos PM y reconcilia denominadores exactos', () => {
  const rawSummary = {
    run: {
      timings: { started: 1000, completed: 1650 },
      executions: [
        {
          item: { name: 'PM-003A - Catalog -> Pricing: Filtro por rango de precio amplio (con paginacion completa)' },
          request: {
            method: 'GET',
            url: `https://apim-g6-productos-chile.azure-api.net/api/v1/productos?access_token=${SYNTHETIC_SECRET}&pagina=1`,
            header: [
              { key: 'Authorization', value: `Bearer ${SYNTHETIC_JWT}` },
              { key: 'X-Correlation-Id', value: 'corr-12345' },
            ],
          },
          response: {
            code: 200,
            responseTime: 120,
            header: [
              { key: 'Content-Type', value: 'application/json' },
              { key: 'Set-Cookie', value: 'session=super-private-cookie' },
            ],
            stream: Buffer.from(JSON.stringify({ privateEmail: 'secret@example.com', token: SYNTHETIC_JWT })),
          },
          assertions: [{ assertion: 'PM-003A: HTTP 200', error: null }],
        },
        // Solicitud auxiliar via pm.sendRequest (pagina 2): sin prefijo PM-XXX
        {
          item: { name: 'https://apim-g6-productos-chile.azure-api.net/api/v1/productos?pagina=2' },
          request: {
            method: 'GET',
            url: 'https://apim-g6-productos-chile.azure-api.net/api/v1/productos?pagina=2',
            header: [{ key: 'Authorization', value: `Bearer ${SYNTHETIC_JWT}` }],
          },
          response: {
            code: 200,
            responseTime: 95,
            header: [{ key: 'Content-Type', value: 'application/json' }],
          },
          assertions: [],
        },
      ],
    },
  };

  const plannedCases = [
    { pmId: 'PM-003A', name: 'PM-003A - Catalog -> Pricing: Filtro por rango de precio amplio (con paginacion completa)', method: 'GET', url: 'https://apim-g6-productos-chile.azure-api.net/api/v1/productos', executable: true },
    { pmId: 'PM-005', name: 'PM-005 - Negativo: Autorizacion insuficiente (403 estricto)', method: 'GET', url: 'https://apim-g6-productos-chile.azure-api.net/api/v1/auditoria-precios', executable: false, blockerReason: 'BLOCKED_AUTH' },
  ];

  const sanitized = sanitizeNewmanRun(rawSummary, {
    runId: 'test-sanitize-h11',
    environmentName: 'local',
    profile: 'smoke',
    extraSecrets: [SYNTHETIC_JWT, SYNTHETIC_SECRET],
    plannedCases,
  });

  assert.equal(sanitized.totals.plannedPmCases, 2);
  assert.equal(sanitized.totals.executedPmCases, 1);
  assert.equal(sanitized.totals.notRunPmCases, 1);
  assert.equal(sanitized.totals.primaryHttpRequests, 1);
  assert.equal(sanitized.totals.auxiliaryHttpRequests, 1);
  assert.equal(
    sanitized.totals.plannedPmCases,
    sanitized.totals.executedPmCases + sanitized.totals.notRunPmCases,
  );
  assert.equal(sanitized.totals.pass, 1);
  assert.equal(sanitized.overallVerdict, 'PARTIAL_NOT_COMPLETE');

  const jsonText = JSON.stringify(sanitized);
  assert.equal(jsonText.includes(SYNTHETIC_JWT), false);
  assert.equal(jsonText.includes(SYNTHETIC_SECRET), false);
  assert.equal(jsonText.includes('super-private-cookie'), false);
  assert.equal(jsonText.includes('secret@example.com'), false);

  const junit = buildSanitizedJunitXml(sanitized, [SYNTHETIC_JWT, SYNTHETIC_SECRET]);
  assert.equal(junit.includes(SYNTHETIC_JWT), false);
  assert.ok(junit.includes('tests="2"'));
  assert.ok(junit.includes('<skipped'));
});

test('H14: sanitizeNewmanRun reconcilia bloqueos dinamicos BLOCKED_FIXTURE en prerequest como NOT_RUN', () => {
  const rawSummary = {
    run: {
      timings: { started: 1000, completed: 1100 },
      failures: [
        {
          source: { name: 'PM-003C - Catalog: Detalle comercial y extraccion de todos los SKUs elegibles' },
          error: { message: 'BLOCKED_FIXTURE: Fixture dinamico requerido ausente (productId).' },
        },
      ],
      executions: [
        {
          item: { name: 'PM-003C - Catalog: Detalle comercial y extraccion de todos los SKUs elegibles' },
          request: { method: 'GET', url: 'http://127.0.0.1:3000/api/v1/productos/' },
          assertions: [],
        },
      ],
    },
  };

  const sanitized = sanitizeNewmanRun(rawSummary, {
    runId: 'test-h14-dynamic-block',
    environmentName: 'local',
    profile: 'folder:01 - Catalog y Pricing',
    plannedCases: [
      { pmId: 'PM-003C', name: 'PM-003C - Catalog: Detalle comercial y extraccion de todos los SKUs elegibles', method: 'GET', url: 'http://127.0.0.1:3000/api/v1/productos/{{productId}}', executable: true },
    ],
  });

  assert.equal(sanitized.totals.plannedPmCases, 1);
  assert.equal(sanitized.totals.executedPmCases, 0);
  assert.equal(sanitized.totals.notRunPmCases, 1);
  assert.equal(sanitized.cases[0].status, 'NOT_RUN');
  assert.ok(sanitized.cases[0].blockerReason.includes('BLOCKED_FIXTURE'));
  assert.equal(sanitized.overallVerdict, 'PARTIAL_NOT_COMPLETE');
});

test('sanitizeNewmanRun falla cerrado si el resumen crudo es invalido', () => {
  assert.throws(() => sanitizeNewmanRun(null), /invalido o ausente/i);
});

test('containsSensitiveLeak detecta connection strings', () => {
  assert.equal(containsSensitiveLeak('postgresql://user:pass@host:5432/db').leaked, true);
});
