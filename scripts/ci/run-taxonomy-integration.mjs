#!/usr/bin/env node
/**
 * Aprovisiona PostgreSQL efímero bajo control del harness y ejecuta las pruebas
 * de integración de taxonomy. Nunca acepta una URL externa como destino de DDL.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import pg from 'pg';

const MINIMO_PRUEBAS = 19;
const ESPEC = 'apps/taxonomy-svc/test/persistencia-drizzle.e2e-spec.ts';
const HARNESS_VARIABLE = 'TAXONOMY_TEST_HARNESS_ID';
const ACK_VARIABLE = 'TAXONOMY_TEST_DB_ACK';
const EPHEMERAL_VARIABLE = 'TAXONOMY_TEST_DB_EPHEMERAL';
const DATABASE_URL_VARIABLE = 'TAXONOMY_TEST_DATABASE_URL';

function fallar(mensaje) {
  throw new Error(mensaje);
}

function ejecutarDocker(argumentos, opciones = {}) {
  const resultado = spawnSync('docker', argumentos, {
    encoding: 'utf8',
    timeout: opciones.timeout ?? 180_000,
    windowsHide: true,
  });
  if (resultado.error) {
    fallar(`no se pudo ejecutar Docker (${resultado.error.message}).`);
  }
  if (resultado.status !== 0) {
    fallar(
      `Docker ${argumentos[0]} terminó con código ${resultado.status}: ${(resultado.stderr || resultado.stdout || '').trim()}`,
    );
  }
  return resultado.stdout.trim();
}

function ejecutarDockerSinFallo(argumentos) {
  spawnSync('docker', argumentos, {
    stdio: 'ignore',
    timeout: 30_000,
    windowsHide: true,
  });
}

function validarEntorno() {
  if (process.env[DATABASE_URL_VARIABLE]?.trim()) {
    fallar(
      `${DATABASE_URL_VARIABLE} está prohibida: el harness genera la URL de su propio contenedor y no acepta destinos externos.`,
    );
  }
}

async function esperarPostgres(nombre) {
  for (let intento = 0; intento < 60; intento += 1) {
    const resultado = spawnSync(
      'docker',
      ['exec', nombre, 'pg_isready', '-U', 'postgres', '-d', 'taxonomy_test'],
      { encoding: 'utf8', timeout: 5_000, windowsHide: true },
    );
    if (resultado.status === 0) return;
    await new Promise((resolver) => setTimeout(resolver, 1_000));
  }
  fallar('PostgreSQL del harness no quedó listo dentro de 60 segundos.');
}

async function comprobarIdentidad(url, harnessId) {
  const cliente = new pg.Client({
    connectionString: url,
    connectionTimeoutMillis: 5_000,
    query_timeout: 5_000,
    statement_timeout: 5_000,
  });
  try {
    await cliente.connect();
    const resultado = await cliente.query(
      "SELECT current_setting('g6.taxonomy_harness_id', true) AS harness_id",
    );
    if (resultado.rows[0]?.harness_id !== harnessId) {
      fallar('el servidor PostgreSQL no acredita la identidad del harness.');
    }
  } finally {
    await cliente.end().catch(() => undefined);
  }
}

async function ejecutar() {
  validarEntorno();
  ejecutarDocker(['info'], { timeout: 10_000 });

  const harnessId = randomBytes(32).toString('hex');
  const nombreContenedor = `g6-taxonomy-${randomUUID().slice(0, 18)}`;
  const password = randomBytes(24).toString('hex');
  let directorio;
  let iniciado = false;

  try {
    ejecutarDocker([
      'run',
      '--detach',
      '--rm',
      '--name',
      nombreContenedor,
      '--label',
      'com.taller-sw.g6.taxonomy-harness=true',
      '--publish',
      '127.0.0.1::5432',
      '--env',
      `POSTGRES_PASSWORD=${password}`,
      '--env',
      'POSTGRES_DB=taxonomy_test',
      'postgres:17-alpine',
      'postgres',
      '-c',
      `g6.taxonomy_harness_id=${harnessId}`,
    ]);
    iniciado = true;

    await esperarPostgres(nombreContenedor);
    const puertoPublicado = ejecutarDocker([
      'port',
      nombreContenedor,
      '5432/tcp',
    ]);
    const coincidenciaPuerto = /^127\.0\.0\.1:(\d+)$/.exec(puertoPublicado);
    if (!coincidenciaPuerto) {
      fallar(
        `Docker publicó PostgreSQL fuera del loopback esperado (${puertoPublicado}).`,
      );
    }

    const url = `postgresql://postgres:${password}@127.0.0.1:${coincidenciaPuerto[1]}/taxonomy_test`;
    await comprobarIdentidad(url, harnessId);

    const require = createRequire(import.meta.url);
    const pkgPath = require.resolve('vitest/package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    const relBin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.vitest;
    if (!relBin) fallar('no se pudo ubicar el binario de vitest.');
    const vitest = join(dirname(pkgPath), relBin);

    directorio = mkdtempSync(join(tmpdir(), 'g6-taxonomy-'));
    const salida = join(directorio, 'vitest.json');
    const resultado = spawnSync(
      process.execPath,
      [
        vitest,
        'run',
        '--config',
        './vitest.config.e2e.ts',
        ESPEC,
        '--reporter=json',
        `--outputFile=${salida}`,
      ],
      {
        stdio: ['ignore', 'inherit', 'inherit'],
        env: {
          ...process.env,
          [DATABASE_URL_VARIABLE]: url,
          [ACK_VARIABLE]: 'desechable-aislado',
          [EPHEMERAL_VARIABLE]: '1',
          [HARNESS_VARIABLE]: harnessId,
        },
      },
    );

    if (!existsSync(salida)) {
      fallar(
        `vitest no generó el reporte JSON (código ${resultado.status ?? 'desconocido'}).`,
      );
    }

    const reporte = JSON.parse(readFileSync(salida, 'utf8'));
    const total = reporte.numTotalTests ?? 0;
    const superadas = reporte.numPassedTests ?? 0;
    const omitidas = reporte.numPendingTests ?? 0;
    const fallidas = reporte.numFailedTests ?? 0;

    if ((resultado.status ?? 1) !== 0) {
      fallar(`vitest terminó con código ${resultado.status}.`);
    }
    if (fallidas > 0) fallar(`${fallidas} prueba(s) fallaron.`);
    if (omitidas > 0) {
      fallar(
        `${omitidas} prueba(s) omitidas: las pruebas de integración no pueden saltarse.`,
      );
    }
    if (total === 0) fallar('no se recolectó ninguna prueba.');
    if (superadas < MINIMO_PRUEBAS) {
      fallar(
        `solo ${superadas} prueba(s) superadas; se esperaban al menos ${MINIMO_PRUEBAS}.`,
      );
    }

    console.log(
      `[taxonomy-integration] PASS: ${superadas}/${total} pruebas superadas, 0 omitidas, 0 fallidas; PostgreSQL ${nombreContenedor} aprovisionado por el harness.`,
    );
  } finally {
    if (directorio) rmSync(directorio, { recursive: true, force: true });
    if (iniciado) ejecutarDockerSinFallo(['rm', '--force', nombreContenedor]);
  }
}

ejecutar().catch((error) => {
  console.error(`[taxonomy-integration] FAIL: ${error.message}`);
  process.exitCode = 1;
});
