#!/usr/bin/env node
/**
 * Ejecuta OBLIGATORIAMENTE las pruebas de integración de taxonomy contra una
 * base PostgreSQL desechable y falla si alguna prueba se omite.
 *
 * Motivo: `npm run test:e2e` sin `TAXONOMY_TEST_DATABASE_URL` marca las 13+
 * pruebas de persistencia como `skip`, produciendo un CI en verde que en
 * realidad no ejecutó nada contra PostgreSQL. Este runner convierte las
 * omisiones en fallo y exige un mínimo de pruebas efectivas.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const MINIMO_PRUEBAS = 17;
const ESPEC = 'apps/taxonomy-svc/test/persistencia-drizzle.e2e-spec.ts';

function fallar(mensaje) {
  console.error(`[taxonomy-integration] ${mensaje}`);
  process.exit(1);
}

const url = process.env.TAXONOMY_TEST_DATABASE_URL?.trim();
const ack = process.env.TAXONOMY_TEST_DB_ACK?.trim();
if (!url) fallar('falta TAXONOMY_TEST_DATABASE_URL (base desechable).');
if (!ack) {
  fallar('falta TAXONOMY_TEST_DB_ACK (acreditación explícita de base desechable).');
}

const require = createRequire(import.meta.url);
const pkgPath = require.resolve('vitest/package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const relBin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.vitest;
if (!relBin) fallar('no se pudo ubicar el binario de vitest.');
const vitest = join(dirname(pkgPath), relBin);

const directorio = mkdtempSync(join(tmpdir(), 'g6-taxonomy-'));
const salida = join(directorio, 'vitest.json');

const args = [
  'run',
  '--config',
  './vitest.config.e2e.ts',
  ESPEC,
  '--reporter=json',
  `--outputFile=${salida}`,
];

const resultado = spawnSync(process.execPath, [vitest, ...args], {
  stdio: ['ignore', 'inherit', 'inherit'],
  env: process.env,
});

if (!existsSync(salida)) {
  rmSync(directorio, { recursive: true, force: true });
  fallar(
    `vitest no generó el reporte JSON (código ${resultado.status ?? 'desconocido'}).`,
  );
}

let crudo;
try {
  crudo = readFileSync(salida, 'utf8');
} catch (error) {
  rmSync(directorio, { recursive: true, force: true });
  fallar(`no se pudo leer el reporte JSON: ${error.message}`);
}
rmSync(directorio, { recursive: true, force: true });

let reporte;
try {
  reporte = JSON.parse(crudo);
} catch (error) {
  fallar(`reporte JSON ilegible: ${error.message}`);
}

const total = reporte.numTotalTests ?? 0;
const superadas = reporte.numPassedTests ?? 0;
const omitidas = reporte.numPendingTests ?? 0;
const fallidas = reporte.numFailedTests ?? 0;

if ((resultado.status ?? 1) !== 0) {
  fallar(`vitest terminó con código ${resultado.status}.`);
}
if (fallidas > 0) {
  fallar(`${fallidas} prueba(s) fallaron.`);
}
if (omitidas > 0) {
  fallar(
    `${omitidas} prueba(s) omitidas: las pruebas de integración no pueden saltarse.`,
  );
}
if (total === 0) {
  fallar('no se recolectó ninguna prueba.');
}
if (superadas < MINIMO_PRUEBAS) {
  fallar(
    `solo ${superadas} prueba(s) superadas; se esperaban al menos ${MINIMO_PRUEBAS}.`,
  );
}

console.log(
  `[taxonomy-integration] PASS: ${superadas}/${total} pruebas superadas, 0 omitidas, 0 fallidas.`,
);
