import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { OPENAPI_CONTRACT_VERSION } from './constants.mjs';
import { containsSensitiveLeak, sha256Buffer } from './sanitizer-core.mjs';

export function resolveGitHead(repoPath) {
  if (!repoPath || !existsSync(repoPath)) return 'UNAVAILABLE';
  try {
    return execFileSync('git', ['-C', repoPath, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return 'UNAVAILABLE';
  }
}

export function verifyDocsFileMatchesGitHead(docsRoot, targetFilePath) {
  if (!docsRoot || !existsSync(docsRoot)) {
    return { ok: false, reason: `Checkout oficial de Docs no encontrado en '${docsRoot}'.` };
  }
  const normRoot = docsRoot.replace(/[\\/]+$/, '');
  const normTarget = targetFilePath;
  const rel = normTarget.startsWith(normRoot)
    ? normTarget.slice(normRoot.length).replace(/^[\\/]+/, '').replace(/\\/g, '/')
    : null;
  if (!rel) {
    return {
      ok: false,
      reason: `H32: Archivo '${targetFilePath}' no pertenece al checkout oficial de Docs '${docsRoot}'.`,
    };
  }
  try {
    const headBlob = execFileSync('git', ['-C', docsRoot, 'show', `HEAD:${rel}`], {
      maxBuffer: 20 * 1024 * 1024,
    });
    const diskBuf = readFileSync(targetFilePath);
    const normalizeLf = (buf) => buf.toString('utf8').replace(/\r\n/g, '\n');
    const headHash = sha256Buffer(normalizeLf(headBlob));
    const diskHash = sha256Buffer(normalizeLf(diskBuf));
    if (headHash !== diskHash) {
      return {
        ok: false,
        reason: `H32: El archivo '${rel}' difiere del commit HEAD declarado en Docs (HEAD=${headHash.slice(0, 12)}, disco=${diskHash.slice(0, 12)}).`,
      };
    }
    return { ok: true, relativePath: rel, sha256: sha256Buffer(diskBuf) };
  } catch (err) {
    return {
      ok: false,
      reason: `H32: No se pudo verificar procedencia de '${rel}' contra HEAD de Docs: ${err.message}`,
    };
  }
}

export function buildManifest({
  runId,
  environmentName,
  profile,
  baseUrlOrigin,
  collectionPath,
  newmanVersion,
  backendSha,
  frontendSha,
  docsSha,
  deployedRevision = 'NO_VERIFICADO_EN_ESTA_CORRIDA',
  evidenceLevel = 'ISOLATED',
  deploymentState = 'LOCAL_HARNESS',
  overallVerdict = 'INCONCLUSIVE',
  plannedCases = [],
  executedCases = [],
  notRunCases = [],
  pmPass = 0,
  pmFail = 0,
  primaryHttpRequests = 0,
  auxiliaryHttpRequests = 0,
  auxiliaryContractViolations = 0,
  fixtures = {},
  blockers = [],
  durationMs = 0,
  exitCode = 0,
  openApiSha256 = 'UNAVAILABLE',
  coverageCsvSha256 = 'UNAVAILABLE',
  contractMode = 'STRICT_OFFICIAL',
}) {
  const collectionHash = existsSync(collectionPath)
    ? sha256Buffer(readFileSync(collectionPath))
    : 'UNAVAILABLE';

  return {
    schemaVersion: '1.3.0',
    runId,
    timestampUtc: new Date().toISOString(),
    environment: environmentName,
    targetOrigin: baseUrlOrigin,
    profile,
    overallVerdict,
    subjects: {
      backendLocalHeadSha: backendSha,
      frontendLocalHeadSha: frontendSha,
      docsLocalHeadSha: docsSha,
      note: 'Los SHAs locales corresponden a los working trees inspeccionados y no se atribuyen al despliegue remoto sin verificacion independiente.',
    },
    deployedRevision,
    collection: {
      file: basename(collectionPath),
      sha256: collectionHash,
    },
    runtime: {
      nodeVersion: process.versions.node,
      newmanVersion,
    },
    contract: {
      openApiVersion: OPENAPI_CONTRACT_VERSION,
      openApiSha256,
      coverageCsvSha256,
      mode: contractMode,
      path: 'contratos/http/openapi.yaml',
    },
    reconciliation: {
      plannedPmCases: plannedCases.length,
      executedPmCases: executedCases.length,
      pmPass,
      pmFail,
      notRunPmCases: notRunCases.length,
      primaryHttpRequests,
      auxiliaryHttpRequests,
      auxiliaryContractViolations,
      plannedCases,
      executedCases,
      notRunCases,
    },
    fixtures,
    evidenceLevel,
    deploymentState,
    blockers,
    durationMs,
    exitCode,
  };
}

export function buildMarkdownReport(manifest, sanitizedSummary, extraSecrets = []) {
  const t = sanitizedSummary.totals;
  const lines = [
    `# Reporte de Pruebas de Integracion HTTP — G6 Hito 5`,
    '',
    `- **Run ID:** \`${manifest.runId}\``,
    `- **Fecha UTC:** \`${manifest.timestampUtc}\``,
    `- **Entorno:** \`${manifest.environment}\` (\`${manifest.targetOrigin}\`)`,
    `- **Perfil:** \`${manifest.profile}\``,
    `- **Veredicto global:** **\`${sanitizedSummary.overallVerdict}\`**`,
    `- **Nivel de evidencia:** \`${manifest.evidenceLevel}\``,
    `- **Estado de despliegue:** \`${manifest.deploymentState}\``,
    `- **Contrato OpenAPI:** \`${manifest.contract.openApiVersion}\` (\`${manifest.contract.mode}\`)`,
    `- **SHA-256 OpenAPI:** \`${manifest.contract.openApiSha256}\``,
    `- **SHA-256 Matriz CSV:** \`${manifest.contract.coverageCsvSha256 || 'UNAVAILABLE'}\``,
    `- **Node.js / Newman:** \`${manifest.runtime.nodeVersion}\` / \`${manifest.runtime.newmanVersion}\``,
    `- **SHA Backend (local):** \`${manifest.subjects.backendLocalHeadSha}\``,
    `- **SHA Frontend (local):** \`${manifest.subjects.frontendLocalHeadSha}\``,
    `- **SHA Docs (local):** \`${manifest.subjects.docsLocalHeadSha}\``,
    `- **SHA-256 Coleccion:** \`${manifest.collection.sha256}\``,
    '',
    '## Resumen y reconciliacion de ejecucion (H11 + H31)',
    '',
    '| Metrica | Valor |',
    '|---|---:|',
    `| Casos PM planificados | ${t.plannedPmCases} |`,
    `| Casos PM ejecutados | ${t.executedPmCases} |`,
    `| Casos PM PASS | ${t.pmPass ?? t.pass} |`,
    `| Casos PM FAIL | ${t.pmFail ?? t.fail} |`,
    `| Casos PM no ejecutados (NOT_RUN) | ${t.notRunPmCases} |`,
    `| Solicitudes HTTP principales | ${t.primaryHttpRequests} |`,
    `| Solicitudes HTTP auxiliares (paginacion/descubrimiento) | ${t.auxiliaryHttpRequests} |`,
    `| Violaciones contractuales auxiliares | ${t.auxiliaryContractViolations ?? 0} |`,
    `| INCONCLUSIVE | ${t.inconclusive} |`,
    `| Aserciones totales | ${t.assertionsTotal} |`,
    `| Aserciones aprobadas | ${t.assertionsPassed} |`,
    `| Aserciones fallidas | ${t.assertionsFailed} |`,
    `| Duracion total (ms) | ${t.durationMs} |`,
    '',
    '## Resultados por caso',
    '',
    '| ID PM | ID INT | Caso | Metodo | HTTP | Aserciones | Duracion (ms) | Correlation ID | Estado | Bloqueo / Nota |',
    '|---|---|---|---|---:|---:|---:|---|---|---|',
  ];

  for (const c of sanitizedSummary.cases) {
    lines.push(
      `| ${c.pmId} | ${c.intId} | ${c.name} | ${c.method} | ${c.httpStatus ?? '-'} | ${c.assertionsPassed}/${c.assertionsTotal} | ${c.durationMs} | \`${c.correlationId || '-'}\` | **${c.status}** | ${c.blockerReason || '-'} |`,
    );
  }

  const failedCases = sanitizedSummary.cases.filter((c) => c.status === 'FAIL');
  if (failedCases.length > 0) {
    lines.push('', '## Detalle de fallos', '');
    for (const c of failedCases) {
      lines.push(`### ${c.pmId} — ${c.name}`);
      if (c.requestError) lines.push(`- Error de red/solicitud: \`${c.requestError}\``);
      for (const a of c.assertions.filter((x) => !x.passed)) {
        lines.push(`- Asercion fallida: **${a.name}** — \`${a.errorMessage || 'sin detalle'}\``);
      }
      lines.push('');
    }
  }

  const auxViolations = sanitizedSummary.auxiliaryContractViolations || [];
  if (auxViolations.length > 0) {
    lines.push('', '## Violaciones contractuales auxiliares (sin caso PM)', '');
    for (const v of auxViolations) {
      lines.push(`- **${v.method || 'HTTP'} ${v.path || v.operationId || 'aux'} (${v.statusCode ?? '-'})** — \`${v.message || (v.errors || []).join('; ')}\``);
    }
  }

  if (manifest.blockers && manifest.blockers.length > 0) {
    lines.push('', '## Bloqueos y advertencias', '');
    for (const b of manifest.blockers) lines.push(`- ${b}`);
  }

  const md = `${lines.join('\n')}\n`;
  const leakCheck = containsSensitiveLeak(md, extraSecrets);
  if (leakCheck.leaked) {
    throw new Error(`Sanitizacion Markdown bloqueada: posible fuga sensible (${leakCheck.reasons.join('; ')}).`);
  }
  return md;
}

export function writeEvidenceBundle(outDir, { manifest, sanitizedSummary, junitXml, markdownReport }) {
  const filesToWrite = [
    { name: 'manifest.json', content: `${JSON.stringify(manifest, null, 2)}\n` },
    {
      name: 'newman-summary.json',
      content: `${JSON.stringify(
        {
          runId: sanitizedSummary.runId,
          overallVerdict: sanitizedSummary.overallVerdict,
          totals: sanitizedSummary.totals,
          generatedAtUtc: sanitizedSummary.generatedAtUtc,
        },
        null,
        2,
      )}\n`,
    },
    { name: 'integration-results.json', content: `${JSON.stringify(sanitizedSummary, null, 2)}\n` },
    { name: 'newman.junit.xml', content: junitXml },
    { name: 'report.md', content: markdownReport },
  ];

  const artifacts = [];
  for (const f of filesToWrite) {
    const fullPath = join(outDir, f.name);
    writeFileSync(fullPath, f.content, 'utf8');
    const savedBytes = readFileSync(fullPath);
    artifacts.push({
      file: f.name,
      bytes: savedBytes.length,
      sha256: sha256Buffer(savedBytes),
    });
  }

  const index = {
    schemaVersion: '1.0.0',
    runId: manifest.runId,
    generatedAtUtc: new Date().toISOString(),
    note: 'evidence-index.json no se incluye en su propio calculo de checksum.',
    artifacts,
  };

  const indexPath = join(outDir, 'evidence-index.json');
  writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`, 'utf8');

  return { indexPath, artifacts };
}
