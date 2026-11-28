import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const SEVERIDADES = ['info', 'low', 'moderate', 'high', 'critical'];

function analizarJsonAuditoria(texto, etiqueta) {
  let informe;
  try {
    informe = JSON.parse(texto);
  } catch (error) {
    throw new Error(`${etiqueta}: JSON inválido (${error.message})`, { cause: error });
  }

  if (!informe || typeof informe !== 'object') {
    throw new Error(`${etiqueta}: informe npm audit incompleto o incompatible`);
  }
  if (informe.error) {
    throw new Error(`${etiqueta}: error del registro npm (${JSON.stringify(informe.error)})`);
  }
  if (
    informe.auditReportVersion !== 2 ||
    !informe.vulnerabilities ||
    typeof informe.vulnerabilities !== 'object' ||
    Array.isArray(informe.vulnerabilities) ||
    !informe.metadata?.vulnerabilities ||
    typeof informe.metadata.vulnerabilities !== 'object' ||
    Array.isArray(informe.metadata.vulnerabilities)
  ) {
    throw new Error(`${etiqueta}: informe npm audit incompleto o incompatible`);
  }

  const entradas = Object.entries(informe.vulnerabilities);
  const conteos = informe.metadata.vulnerabilities;
  const calculados = Object.fromEntries(SEVERIDADES.map((severidad) => [severidad, 0]));
  for (const [nombre, vulnerabilidad] of entradas) {
    if (
      vulnerabilidad?.name !== nombre ||
      !SEVERIDADES.includes(vulnerabilidad.severity) ||
      typeof vulnerabilidad.isDirect !== 'boolean' ||
      !Array.isArray(vulnerabilidad.via) ||
      vulnerabilidad.via.length === 0 ||
      !Array.isArray(vulnerabilidad.nodes) ||
      vulnerabilidad.nodes.length === 0 ||
      !Array.isArray(vulnerabilidad.effects) ||
      typeof vulnerabilidad.range !== 'string'
    ) {
      throw new Error(`${etiqueta}: entrada de vulnerabilidad incompleta (${nombre})`);
    }
    calculados[vulnerabilidad.severity] += 1;
  }

  for (const severidad of SEVERIDADES) {
    if (!Number.isInteger(conteos[severidad]) || conteos[severidad] !== calculados[severidad]) {
      throw new Error(`${etiqueta}: conteo ${severidad} incompleto o inconsistente`);
    }
  }
  if (!Number.isInteger(conteos.total) || conteos.total !== entradas.length) {
    throw new Error(`${etiqueta}: total de vulnerabilidades incompleto o inconsistente`);
  }
  return informe;
}

export function evaluarAuditorias({
  auditoriaCompleta,
  auditoriaProduccion,
  shaEvaluado,
}) {
  const evidencia = {
    schemaVersion: 1,
    auditedSha: shaEvaluado || null,
    pullRequestHeadSha: process.env.PR_HEAD_SHA || null,
    pullRequestBaseSha: process.env.PR_BASE_SHA || null,
    actionsRunId: process.env.ACTIONS_RUN_ID || null,
    evaluatedAtUtc: new Date().toISOString(),
    fullAudit: {
      command: 'npm audit --audit-level=high --json',
      exitCode: auditoriaCompleta?.exitCode ?? null,
      signal: auditoriaCompleta?.signal || null,
      processError: auditoriaCompleta?.error || null,
      vulnerabilities: null,
    },
    productionAudit: {
      command: 'npm audit --omit=dev --audit-level=high --json',
      exitCode: auditoriaProduccion?.exitCode ?? null,
      signal: auditoriaProduccion?.signal || null,
      processError: auditoriaProduccion?.error || null,
      vulnerabilities: null,
    },
    decision: { status: 'FAIL', mode: 'rejected', reason: 'evaluación incompleta' },
  };

  try {
    if (!/^[0-9a-f]{40}$/i.test(shaEvaluado || '')) {
      throw new Error('SHA evaluado ausente o inválido');
    }
    const completa = validarEjecucion(auditoriaCompleta, 'auditoría completa');
    const produccion = validarEjecucion(auditoriaProduccion, 'auditoría de producción');
    const full = analizarJsonAuditoria(completa.stdout, 'auditoría completa');
    const prod = analizarJsonAuditoria(produccion.stdout, 'auditoría de producción');
    evidencia.fullAudit.vulnerabilities = full.metadata.vulnerabilities;
    evidencia.productionAudit.vulnerabilities = prod.metadata.vulnerabilities;

    if (produccion.exitCode !== 0 || prod.metadata.vulnerabilities.total !== 0) {
      throw new Error('auditoría de producción no terminó limpia');
    }

    const severas = Object.entries(full.vulnerabilities).filter(([, v]) =>
      ['high', 'critical'].includes(v.severity),
    );
    if (severas.length === 0) {
      if (completa.exitCode !== 0) {
        throw new Error(`código de salida inesperado en auditoría completa: ${completa.exitCode}`);
      }
      evidencia.decision = {
        status: 'PASS',
        mode: 'normal',
        reason: 'sin vulnerabilidades High/Critical',
        highCriticalPackages: [],
        advisoryIds: [],
      };
      return evidencia;
    }

    throw new Error(`auditoría completa detectó ${severas.length} paquetes High/Critical`);
  } catch (error) {
    evidencia.decision = {
      status: 'FAIL',
      mode: 'rejected',
      reason: error.message,
    };
    return evidencia;
  }
}

function validarEjecucion(resultado, etiqueta) {
  if (!resultado) {
    throw new Error(`${etiqueta}: resultado de proceso ausente`);
  }
  if (resultado.error || resultado.signal) {
    throw new Error(`${etiqueta}: error de infraestructura (${resultado.error?.message || resultado.signal})`);
  }
  if (/\b(?:ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|ENOAUDIT)\b|fetch failed|network error|npm ERR!/i.test(resultado.stderr || '')) {
    throw new Error(`${etiqueta}: error de infraestructura o transporte en stderr`);
  }
  if (typeof resultado.exitCode !== 'number') {
    throw new Error(`${etiqueta}: resultado de proceso ausente`);
  }
  if (![0, 1].includes(resultado.exitCode)) {
    throw new Error(`${etiqueta}: código de salida inesperado ${resultado.exitCode}`);
  }
  return resultado;
}

function ejecutarNpmAudit(argumentos) {
  console.log(`> npm ${argumentos.join(' ')}`);
  const candidatos = [
    process.env.npm_execpath,
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].filter(Boolean);
  const npmCli = candidatos.map((candidato) => resolve(candidato)).find((candidato) => existsSync(candidato));
  if (!npmCli) {
    return { exitCode: null, signal: null, error: { message: 'npm CLI no encontrado', code: 'ENOENT' }, stdout: '', stderr: '' };
  }
  const resultado = spawnSync(process.execPath, [npmCli, ...argumentos], {
    cwd: process.cwd(),
    encoding: 'utf8',
    shell: false,
    timeout: 300_000,
    windowsHide: true,
  });
  return {
    exitCode: typeof resultado.status === 'number' ? resultado.status : null,
    signal: resultado.signal || null,
    error: resultado.error ? { message: resultado.error.message, code: resultado.error.code || null } : null,
    stdout: resultado.stdout || '',
    stderr: resultado.stderr || '',
  };
}

function gitSha() {
  const resultado = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
  return resultado.status === 0 ? resultado.stdout.trim() : null;
}

function escribirSiDisponible(ruta, contenido) {
  if (ruta) writeFileSync(ruta, contenido, 'utf8');
}

function main() {
  const directorio = process.env.G6_AUDIT_EVIDENCE_DIR || join(process.cwd(), 'dependency-audit-evidence');
  mkdirSync(directorio, { recursive: true });

  const completa = ejecutarNpmAudit(['audit', '--audit-level=high', '--json']);
  escribirSiDisponible(join(directorio, 'dependency-audit.json'), completa.stdout);
  escribirSiDisponible(join(directorio, 'dependency-audit-stderr.txt'), completa.stderr);

  const produccion = ejecutarNpmAudit(['audit', '--omit=dev', '--audit-level=high', '--json']);
  escribirSiDisponible(join(directorio, 'dependency-audit-production.json'), produccion.stdout);
  escribirSiDisponible(join(directorio, 'dependency-audit-production-stderr.txt'), produccion.stderr);

  const evaluacion = evaluarAuditorias({
    auditoriaCompleta: completa,
    auditoriaProduccion: produccion,
    shaEvaluado: process.env.GITHUB_SHA || gitSha(),
  });
  escribirSiDisponible(join(directorio, 'dependency-audit-decision.json'), `${JSON.stringify(evaluacion, null, 2)}\n`);

  console.log(JSON.stringify(evaluacion, null, 2));
  if (evaluacion.decision.status !== 'PASS') {
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    const directorio = process.env.G6_AUDIT_EVIDENCE_DIR || join(process.cwd(), 'dependency-audit-evidence');
    mkdirSync(directorio, { recursive: true });
    writeFileSync(join(directorio, 'dependency-audit-decision.json'), `${JSON.stringify({ schemaVersion: 1, decision: { status: 'FAIL', mode: 'rejected', reason: error.message } }, null, 2)}\n`, 'utf8');
    console.error(error);
    process.exitCode = 1;
  }
}
