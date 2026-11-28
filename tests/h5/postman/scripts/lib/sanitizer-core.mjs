import { createHash } from 'node:crypto';
import { CASE_METADATA, SENSITIVE_KEY_PATTERNS, SENSITIVE_VALUE_PATTERNS } from './constants.mjs';

const REDACTED = '[REDACTED]';

export function redactString(input, extraSecrets = []) {
  if (typeof input !== 'string') return input;
  let out = input;

  for (const secret of extraSecrets) {
    if (typeof secret === 'string' && secret.length >= 6) {
      out = out.split(secret).join(REDACTED);
    }
  }

  for (const pattern of SENSITIVE_VALUE_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.source.startsWith('([?&]')) {
      out = out.replace(pattern, `$1${REDACTED}`);
    } else {
      out = out.replace(pattern, REDACTED);
    }
  }

  return out;
}

export function sanitizeErrorMessage(rawMessage, extraSecrets = []) {
  if (!rawMessage) return null;
  const text = typeof rawMessage === 'string' ? rawMessage : String(rawMessage);
  let firstLine = text.split(/\r?\n/)[0].trim();
  firstLine = firstLine.replace(/\{[^}]{12,}\}/g, '{[BODY_REDACTED]}');
  firstLine = firstLine.replace(/\[[^\]]{24,}\]/g, '[[BODY_REDACTED]]');
  firstLine = firstLine.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[EMAIL_REDACTED]');
  firstLine = redactString(firstLine, extraSecrets);
  if (firstLine.length > 220) {
    firstLine = `${firstLine.slice(0, 217)}...`;
  }
  return firstLine;
}

export function sanitizeUrl(rawUrl, extraSecrets = []) {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  try {
    const u = new URL(rawUrl);
    for (const k of Array.from(u.searchParams.keys())) {
      if (SENSITIVE_KEY_PATTERNS.some((rx) => rx.test(k))) {
        u.searchParams.delete(k);
      }
    }
    u.username = '';
    u.password = '';
    return redactString(u.toString(), extraSecrets);
  } catch {
    return redactString(rawUrl, extraSecrets);
  }
}

export function containsSensitiveLeak(text, extraSecrets = []) {
  if (typeof text !== 'string') return { leaked: false, reasons: [] };
  const reasons = [];

  for (const secret of extraSecrets) {
    if (typeof secret === 'string' && secret.length >= 6 && text.includes(secret)) {
      reasons.push('Exact runtime secret match detected in output');
    }
  }

  for (const pattern of SENSITIVE_VALUE_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) {
      reasons.push(`Sensitive pattern matched: ${pattern.source}`);
    }
  }

  return { leaked: reasons.length > 0, reasons };
}

function getHeaderValue(headers = [], targetName) {
  const lower = targetName.toLowerCase();
  const found = (headers || []).find((h) => String(h.key || h.name || '').toLowerCase() === lower);
  return found ? String(found.value || '') : '';
}

function extractPmId(itemName = '') {
  const match = String(itemName).match(/^(PM-\d+[A-Z]?)\b/);
  return match ? match[1] : null;
}

export function computeOverallVerdict(totals) {
  if (totals.fail > 0) return 'FAIL';
  if (totals.inconclusive > 0) return 'INCONCLUSIVE';
  if (totals.plannedPmCases > 0 && totals.notRunPmCases > 0) return 'PARTIAL_NOT_COMPLETE';
  if (totals.plannedPmCases > 0 && totals.pass === totals.plannedPmCases) return 'PASS';
  return 'INCONCLUSIVE';
}

/**
 * H11 + H14: Reconcilia exactamente casos PM planificados, ejecutados, NOT_RUN (incluyendo
 * bloqueos dinamicos de fixtures) y separa solicitudes HTTP principales de las auxiliares
 * generadas por pm.sendRequest (paginacion/descubrimiento).
 */
export function sanitizeNewmanRun(rawSummary, options = {}) {
  const {
    runId = 'unknown-run',
    environmentName = 'unknown',
    profile = 'smoke',
    extraSecrets = [],
    evidenceLevel = 'LAB_AZURE',
    plannedCases = null,
  } = options;

  if (!rawSummary || typeof rawSummary !== 'object' || !rawSummary.run) {
    throw new Error('Resumen crudo de Newman invalido o ausente: no se puede sanear.');
  }

  const executions = Array.isArray(rawSummary.run.executions) ? rawSummary.run.executions : [];
  const runFailures = Array.isArray(rawSummary.run.failures) ? rawSummary.run.failures : [];
  const prerequestBlockedByItem = new Map();
  const prerequestBlockedByPmId = new Map();
  for (const f of runFailures) {
    const msg = String(f?.error?.message || '');
    const srcName = String(f?.source?.name || '');
    if (msg.includes('BLOCKED_FIXTURE') && srcName) {
      const cleanMsg = sanitizeErrorMessage(msg, extraSecrets);
      prerequestBlockedByItem.set(srcName, cleanMsg);
      const pmIdFromFail = extractPmId(srcName);
      if (pmIdFromFail) prerequestBlockedByPmId.set(pmIdFromFail, cleanMsg);
    }
  }
  const executedById = new Map();
  const primaryRecords = [];
  const auxiliaryRequests = [];

  for (const exec of executions) {
    const itemName = redactString(exec.item?.name || '', extraSecrets);
    const pmId = extractPmId(itemName);

    let rawUrl = '';
    if (typeof exec.request?.url === 'string') {
      rawUrl = exec.request.url;
    } else if (exec.request?.url && typeof exec.request.url === 'object') {
      const u = exec.request.url;
      const proto = u.protocol ? `${u.protocol}://` : 'https://';
      const host = Array.isArray(u.host) ? u.host.join('.') : String(u.host || '');
      const port = u.port ? `:${u.port}` : '';
      const path = Array.isArray(u.path) ? `/${u.path.join('/')}` : String(u.path || '');
      const query = Array.isArray(u.query) && u.query.length > 0
        ? `?${u.query.filter((q) => !q.disabled).map((q) => `${encodeURIComponent(q.key)}=${encodeURIComponent(q.value ?? '')}`).join('&')}`
        : '';
      rawUrl = `${proto}${host}${port}${path}${query}`;
    }

    const reqHeaders = exec.request?.header || [];
    const resHeaders = exec.response?.header || [];
    const correlationId = redactString(
      getHeaderValue(resHeaders, 'x-correlation-id') || getHeaderValue(reqHeaders, 'x-correlation-id') || '',
      extraSecrets,
    );

    // H11: Solicitudes auxiliares (pm.sendRequest de paginacion/descubrimiento) no tienen prefijo PM-XXX
    if (!pmId) {
      auxiliaryRequests.push({
        method: String(exec.request?.method || 'GET').toUpperCase(),
        url: sanitizeUrl(rawUrl, extraSecrets),
        httpStatus: exec.response?.code ?? null,
        durationMs: exec.response?.responseTime ?? 0,
        correlationId,
      });
      continue;
    }

    const meta = CASE_METADATA[pmId] || {
      intId: 'N/A',
      services: ['api-gateway'],
      type: 'lectura',
      scope: 'desconocido',
    };

    const contentType = redactString(getHeaderValue(resHeaders, 'content-type') || '', extraSecrets);
    const assertionsRaw = Array.isArray(exec.assertions) ? exec.assertions : [];
    const assertions = assertionsRaw.map((a) => ({
      name: redactString(a.assertion || '', extraSecrets),
      passed: !a.error,
      errorMessage: a.error ? sanitizeErrorMessage(a.error.message || String(a.error), extraSecrets) : null,
    }));

    const passedAssertions = assertions.filter((a) => a.passed).length;
    const failedAssertions = assertions.filter((a) => !a.passed).length;
    const requestError = exec.requestError
      ? sanitizeErrorMessage(
          exec.requestError.message ||
            exec.requestError.code ||
            (typeof exec.requestError === 'object' ? JSON.stringify(exec.requestError) : String(exec.requestError)),
          extraSecrets,
        )
      : null;

    // H14: Si la solicitud aborto preventivamente en prerequest por fixture dinamico faltante
    // (ya sea via error BLOCKED_FIXTURE o via pm.execution.skipRequest() sin respuesta HTTP)
    const skippedByDynamicFixture =
      !exec.response &&
      !requestError &&
      assertions.length === 0 &&
      Array.isArray(meta.requiresFixtures) &&
      meta.requiresFixtures.length > 0
        ? `BLOCKED_FIXTURE: Solicitud omitida preventivamente por fixture dinamico ausente [${meta.requiresFixtures.join(', ')}].`
        : null;

    const blockedFixtureErr =
      (requestError && requestError.includes('BLOCKED_FIXTURE'))
        ? requestError
        : (exec.prerequestError && String(exec.prerequestError.message || '').includes('BLOCKED_FIXTURE'))
          ? sanitizeErrorMessage(exec.prerequestError.message, extraSecrets)
          : prerequestBlockedByItem.get(exec.item?.name || '') || skippedByDynamicFixture || null;

    let status = 'PASS';
    let blockerReason = null;

    if (blockedFixtureErr) {
      status = 'NOT_RUN';
      blockerReason = blockedFixtureErr;
    } else if (requestError) {
      status = 'FAIL';
      blockerReason = requestError;
    } else if (failedAssertions > 0) {
      status = 'FAIL';
    } else if (assertions.length === 0) {
      status = 'INCONCLUSIVE';
      blockerReason = 'No se ejecutaron aserciones en la solicitud.';
    }

    const record = {
      pmId,
      intId: meta.intId,
      name: itemName,
      services: meta.services,
      type: meta.type,
      scope: meta.scope,
      method: String(exec.request?.method || 'GET').toUpperCase(),
      url: sanitizeUrl(rawUrl, extraSecrets),
      httpStatus: exec.response?.code ?? null,
      contentType,
      durationMs: exec.response?.responseTime ?? 0,
      correlationId,
      assertionsTotal: assertions.length,
      assertionsPassed: passedAssertions,
      assertionsFailed: failedAssertions,
      assertions,
      requestError,
      evidenceLevel,
      status,
      blockerReason,
    };

    const existingPrimary = executedById.get(pmId);
    if (existingPrimary) {
      // H11: Newman etiqueta llamadas auxiliares pm.sendRequest con el mismo item.name del caso padre.
      // Conservamos como primario el que tiene aserciones (o requestError); el otro pasa a auxiliaryRequests.
      const currentIsPrimary = assertions.length > 0 && existingPrimary.assertionsTotal === 0 && !existingPrimary.requestError;
      if (currentIsPrimary) {
        auxiliaryRequests.push({
          parentPmId: pmId,
          method: existingPrimary.method,
          url: existingPrimary.url,
          httpStatus: existingPrimary.httpStatus,
          durationMs: existingPrimary.durationMs,
          correlationId: existingPrimary.correlationId,
        });
        const idx = primaryRecords.indexOf(existingPrimary);
        if (idx >= 0) primaryRecords.splice(idx, 1, record);
        executedById.set(pmId, record);
      } else {
        auxiliaryRequests.push({
          parentPmId: pmId,
          method: record.method,
          url: record.url,
          httpStatus: record.httpStatus,
          durationMs: record.durationMs,
          correlationId: record.correlationId,
        });
      }
    } else {
      executedById.set(pmId, record);
      primaryRecords.push(record);
    }
  }

  let cases;
  if (Array.isArray(plannedCases) && plannedCases.length > 0) {
    cases = [];
    for (const plan of plannedCases) {
      const executed = executedById.get(plan.pmId);
      if (executed) {
        cases.push(executed);
      } else {
        const meta = CASE_METADATA[plan.pmId] || {
          intId: 'N/A',
          services: ['api-gateway'],
          type: 'lectura',
          scope: 'desconocido',
        };
        const dynamicBlock =
          prerequestBlockedByItem.get(plan.name) ||
          prerequestBlockedByPmId.get(plan.pmId) ||
          (plan.executable &&
          Array.isArray(meta.requiresFixtures) &&
          meta.requiresFixtures.length > 0 &&
          primaryRecords.some((r) => r.status === 'FAIL')
            ? `BLOCKED_FIXTURE: Omitido preventivamente por skipRequest() al fallar productor previo de [${meta.requiresFixtures.join(', ')}].`
            : null);
        const isBlockedNotRun = !plan.executable || Boolean(dynamicBlock);
        cases.push({
          pmId: plan.pmId,
          intId: meta.intId,
          name: redactString(plan.name, extraSecrets),
          services: meta.services,
          type: meta.type,
          scope: meta.scope,
          method: plan.method || 'GET',
          url: sanitizeUrl(plan.url || '', extraSecrets),
          httpStatus: null,
          contentType: '',
          durationMs: 0,
          correlationId: '',
          assertionsTotal: 0,
          assertionsPassed: 0,
          assertionsFailed: 0,
          assertions: [],
          requestError: null,
          evidenceLevel,
          status: isBlockedNotRun ? 'NOT_RUN' : 'INCONCLUSIVE',
          blockerReason: dynamicBlock
            ? dynamicBlock
            : isBlockedNotRun
              ? plan.blockerReason || 'Caso no ejecutado por bloqueo previo.'
              : 'Caso planificado para ejecucion pero ausente en el resultado de Newman (ejecucion incompleta).',
        });
      }
    }
  } else {
    cases = primaryRecords;
  }

  const timings = rawSummary.run.timings || {};
  const totalDurationMs = timings.completed && timings.started ? timings.completed - timings.started : 0;

  const pass = cases.filter((c) => c.status === 'PASS').length;
  const fail = cases.filter((c) => c.status === 'FAIL').length;
  const inconclusive = cases.filter((c) => c.status === 'INCONCLUSIVE').length;
  const notRunPmCases = cases.filter((c) => c.status === 'NOT_RUN').length;
  const plannedPmCases = cases.length;
  const executedPmCases = pass + fail + inconclusive;

  const totals = {
    // H11 + H31: Denominadores explicitos y reconciliados (plannedPmCases === executedPmCases + notRunPmCases)
    plannedPmCases,
    executedPmCases,
    pmPass: pass,
    pmFail: fail,
    notRunPmCases,
    primaryHttpRequests: primaryRecords.filter((r) => r.status !== 'NOT_RUN').length,
    auxiliaryHttpRequests: auxiliaryRequests.length,
    auxiliaryContractViolations: 0,
    // Compatibilidad de campos
    planned: plannedPmCases,
    executed: executedPmCases,
    notRun: notRunPmCases,
    requests: plannedPmCases,
    pass,
    fail,
    inconclusive,
    assertionsTotal: cases.reduce((acc, c) => acc + c.assertionsTotal, 0),
    assertionsPassed: cases.reduce((acc, c) => acc + c.assertionsPassed, 0),
    assertionsFailed: cases.reduce((acc, c) => acc + c.assertionsFailed, 0),
    durationMs: totalDurationMs,
  };

  const overallVerdict = computeOverallVerdict(totals);

  const summary = {
    runId,
    environmentName,
    profile,
    evidenceLevel,
    overallVerdict,
    generatedAtUtc: new Date().toISOString(),
    totals,
    cases,
    auxiliaryRequests,
    auxiliaryContractViolations: [],
  };

  const serialized = JSON.stringify(summary);
  const leakCheck = containsSensitiveLeak(serialized, extraSecrets);
  if (leakCheck.leaked) {
    throw new Error(`Sanitizacion bloqueada: se detecto posible fuga sensible (${leakCheck.reasons.join('; ')}).`);
  }

  return summary;
}

export function buildSanitizedJunitXml(sanitizedSummary, extraSecrets = []) {
  const escapeXml = (str) =>
    String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');

  const auxViolations = Array.isArray(sanitizedSummary.auxiliaryContractViolations)
    ? sanitizedSummary.auxiliaryContractViolations
    : [];
  const tests = sanitizedSummary.cases.length + auxViolations.length;
  const failures =
    sanitizedSummary.cases.filter((c) => c.status === 'FAIL').length +
    auxViolations.length;
  const skipped = sanitizedSummary.cases.filter((c) => c.status === 'NOT_RUN' || c.status === 'INCONCLUSIVE').length;
  const timeSec = ((sanitizedSummary.totals.durationMs || 0) / 1000).toFixed(3);

  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="G6 - H5 Integration Suite" tests="${tests}" failures="${failures}" skipped="${skipped}" time="${timeSec}">`,
    `  <testsuite name="${escapeXml(sanitizedSummary.profile)}" tests="${tests}" failures="${failures}" skipped="${skipped}" time="${timeSec}">`,
  ];

  for (const c of sanitizedSummary.cases) {
    const caseTime = ((c.durationMs || 0) / 1000).toFixed(3);
    lines.push(`    <testcase classname="${escapeXml(c.intId)}" name="${escapeXml(c.name)}" time="${caseTime}">`);
    if (c.status === 'FAIL') {
      const failedMsgs = c.assertions
        .filter((a) => !a.passed)
        .map((a) => `${a.name}: ${a.errorMessage || 'failed'}`);
      if (c.requestError) failedMsgs.unshift(`RequestError: ${c.requestError}`);
      lines.push(`      <failure message="${escapeXml(failedMsgs.join(' | ') || 'Assertion failed')}"/>`);
    } else if (c.status === 'NOT_RUN' || c.status === 'INCONCLUSIVE') {
      lines.push(`      <skipped message="${escapeXml(c.blockerReason || c.status)}"/>`);
    }
    lines.push('    </testcase>');
  }

  for (let i = 0; i < auxViolations.length; i += 1) {
    const v = auxViolations[i];
    const name = `H31 Auxiliary Contract Violation #${i + 1} (${v.method || 'HTTP'} ${v.path || v.operationId || 'aux'} ${v.statusCode ?? ''})`;
    lines.push(`    <testcase classname="H31.AuxiliaryContract" name="${escapeXml(name)}" time="0.000">`);
    lines.push(`      <failure message="${escapeXml(v.message || (v.errors || []).join('; ') || 'Auxiliary contract violation')}"/>`);
    lines.push('    </testcase>');
  }

  lines.push('  </testsuite>');
  lines.push('</testsuites>');

  const xml = `${lines.join('\n')}\n`;
  const leakCheck = containsSensitiveLeak(xml, extraSecrets);
  if (leakCheck.leaked) {
    throw new Error(`Sanitizacion JUnit bloqueada: posible fuga sensible (${leakCheck.reasons.join('; ')}).`);
  }
  return xml;
}

export function sha256Buffer(bufferOrString) {
  return createHash('sha256').update(bufferOrString).digest('hex');
}
