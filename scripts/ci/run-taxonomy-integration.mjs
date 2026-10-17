#!/usr/bin/env node
/**
 * Ejecuta OBLIGATORIAMENTE las pruebas de integración de taxonomy contra una
 * instancia PostgreSQL efímera acreditada, y falla si alguna prueba se omite.
 *
 * Motivo: `npm run test:e2e` sin `TAXONOMY_TEST_DATABASE_URL` marca las pruebas
 * de persistencia como `skip`, produciendo un CI en verde que no ejecutó nada.
 * Además, un `DROP SCHEMA ... CASCADE` nunca debe apuntar a una base compartida
 * (p. ej. Supabase) ni a un túnel local hacia otra instancia.
 *
 * Este runner:
 *  1. Exige `TAXONOMY_TEST_DB_EPHEMERAL=1` (declaración explícita de entorno).
 *  2. Valida el host (solo loopback numérico) y rechaza proveedores gestionados.
 *  3. Verifica en vivo `inet_server_addr()` (loopback/privada).
 *  4. Siembra el testigo efímero que las pruebas verifican antes de todo DDL.
 *  5. Ejecuta vitest y convierte cualquier omisión en fallo.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import pg from 'pg';

const MINIMO_PRUEBAS = 17;
const ESPEC = 'apps/taxonomy-svc/test/persistencia-drizzle.e2e-spec.ts';
const WITNESS_VARIABLE = 'TAXONOMY_TEST_DB_WITNESS';

function fallar(mensaje) {
  console.error(`[taxonomy-integration] ${mensaje}`);
  process.exit(1);
}

function esHostLoopback(host) {
  const h = String(host).replace(/^\[|\]$/g, '').toLowerCase();
  return h === '127.0.0.1' || h === '::1';
}

function esDireccionLocalOPrivada(direccion) {
  if (!direccion) return false;
  const addr = String(direccion).trim().toLowerCase().split('/')[0];
  if (addr.startsWith('127.') || addr === '::1') return true;
  if (addr.startsWith('10.')) return true;
  if (addr.startsWith('192.168.')) return true;
  const privado172 = /^172\.(\d{1,2})\./.exec(addr);
  if (privado172) {
    const octeto = Number(privado172[1]);
    if (octeto >= 16 && octeto <= 31) return true;
  }
  if (addr.startsWith('fe80:') || addr.startsWith('fc') || addr.startsWith('fd')) {
    return true;
  }
  return false;
}

const url = process.env.TAXONOMY_TEST_DATABASE_URL?.trim();
const ack = process.env.TAXONOMY_TEST_DB_ACK?.trim();
const efimera = process.env.TAXONOMY_TEST_DB_EPHEMERAL?.trim();

if (!url) fallar('falta TAXONOMY_TEST_DATABASE_URL (base desechable).');
if (!ack) {
  fallar('falta TAXONOMY_TEST_DB_ACK (acreditación explícita de base desechable).');
}
if (efimera !== '1') {
  fallar('falta TAXONOMY_TEST_DB_EPHEMERAL=1 (declaración de entorno efímero).');
}

let parsed;
try {
  parsed = new URL(url);
} catch {
  fallar('TAXONOMY_TEST_DATABASE_URL no es una URL válida.');
}
if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
  fallar(`protocolo no soportado (${parsed.protocol}).`);
}
if (!esHostLoopback(parsed.hostname)) {
  fallar(
    `host no local (${parsed.hostname}); solo se admite 127.0.0.1 o ::1 (ni 0.0.0.0 ni localhost).`,
  );
}

const testigo = randomBytes(24).toString('hex');

async function prepararInstanciaEfimera() {
  const cliente = new pg.Client({
    connectionString: url,
    connectionTimeoutMillis: 5000,
    query_timeout: 5000,
    statement_timeout: 5000,
  });
  try {
    await cliente.connect();
    const info = await cliente.query(
      'SELECT inet_server_addr()::text AS direccion',
    );
    const direccion = info.rows[0]?.direccion ?? null;
    if (!esDireccionLocalOPrivada(direccion)) {
      fallar(
        `la instancia no es local ni efímera (inet_server_addr=${direccion ?? 'null'}); posible túnel o servidor remoto.`,
      );
    }
    await cliente.query('CREATE SCHEMA IF NOT EXISTS g6_ephemeral_probe');
    await cliente.query(
      'CREATE TABLE IF NOT EXISTS g6_ephemeral_probe.witness (id text PRIMARY KEY, token text NOT NULL)',
    );
    await cliente.query(
      `INSERT INTO g6_ephemeral_probe.witness (id, token) VALUES ('taxonomy', $1)
       ON CONFLICT (id) DO UPDATE SET token = EXCLUDED.token`,
      [testigo],
    );
  } catch (error) {
    fallar(`no se pudo preparar la instancia efímera: ${error.message}`);
  } finally {
    await cliente.end().catch(() => undefined);
  }
}

await prepararInstanciaEfimera();

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
  env: { ...process.env, [WITNESS_VARIABLE]: testigo },
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
