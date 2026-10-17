/**
 * Acreditación obligatoria de bases PostgreSQL desechables para pruebas.
 *
 * Las pruebas de integración de taxonomy ejecutan DDL destructivo
 * (`DROP SCHEMA IF EXISTS taxonomy CASCADE`). Este módulo garantiza que ese
 * DDL solo pueda construirse/ejecutarse contra una instancia PostgreSQL
 * efímera acreditada en vivo.
 *
 * Defensas (defensa en profundidad):
 *  1. Confirmación explícita independiente (`TAXONOMY_TEST_DB_ACK`).
 *  2. Host de la URL estrictamente loopback numérico (127.0.0.1 / ::1). NO se
 *     admite `0.0.0.0` (dirección de escucha comodín) ni `localhost` (puede
 *     resolverse a un túnel).
 *  3. El harness aprovisiona PostgreSQL en un contenedor propio e inicia el
 *     servidor con un identificador aleatorio de sesión. La conexión debe
 *     presentar ese identificador mediante current_setting(); crear un testigo
 *     dentro de una URL recibida no acredita quién aprovisionó la instancia.
 *  4. Preflight en vivo: la instancia debe reportar una dirección de servidor
 *     local/privada y el identificador de harness esperado.
 *
 * Solo una `AcreditacionInstanciaEfimera` (obtenida tras el preflight en vivo)
 * permite construir el DDL destructivo.
 */

import pg from 'pg';

export const ACK_VARIABLE = 'TAXONOMY_TEST_DB_ACK';
export const ACK_VALOR = 'desechable-aislado';
export const HARNESS_ID_VARIABLE = 'TAXONOMY_TEST_HARNESS_ID';
export const HARNESS_ID_SETTING = 'g6.taxonomy_harness_id';

export class BaseNoAisladaError extends Error {
  constructor(detalle: string) {
    super('Base de datos no acreditada como desechable de prueba: ' + detalle);
    this.name = 'BaseNoAisladaError';
  }
}

// Solo loopback numérico. `localhost` queda fuera: puede apuntar a un túnel.
const HOSTS_LOOPBACK = new Set(['127.0.0.1', '::1']);

const PATRONES_COMPARTIDOS: readonly RegExp[] = [
  /supabase\.(co|com|net|io)/i,
  /\.supabase\.co/i,
  /pooler\.supabase/i,
  /supabase/i,
  /\.rds\.amazonaws\.com/i,
  /\.amazonaws\.com/i,
  /\.neon\.tech/i,
  /\.railway\.app/i,
  /\.render\.com/i,
  /\.azure\.com/i,
];

export function normalizarHost(host: string): string {
  return host.replace(/^\[|\]$/g, '').toLowerCase();
}

/** Host que pertenece a un proveedor gestionado o a una red compartida. */
export function esHostCompartido(host: string): boolean {
  const h = normalizarHost(host);
  if (HOSTS_LOOPBACK.has(h)) return false;
  return PATRONES_COMPARTIDOS.some((patron) => patron.test(h));
}

/** Host estrictamente loopback (127.0.0.1 / ::1). NO incluye 0.0.0.0 ni localhost. */
export function esHostDesechable(host: string): boolean {
  return HOSTS_LOOPBACK.has(normalizarHost(host));
}

/**
 * Dirección loopback o privada (RFC1918 / ULA / link-local). Una dirección
 * pública indica un servidor remoto o un túnel hacia Internet y se rechaza.
 */
export function esDireccionLocalOPrivada(
  direccion: string | null | undefined,
): boolean {
  if (!direccion) return false;
  const addr = direccion.trim().toLowerCase().split('/')[0];
  if (addr.startsWith('127.') || addr === '::1') return true;
  if (addr.startsWith('10.')) return true;
  if (addr.startsWith('192.168.')) return true;
  const privado172 = /^172\.(\d{1,2})\./.exec(addr);
  if (privado172) {
    const octeto = Number(privado172[1]);
    if (octeto >= 16 && octeto <= 31) return true;
  }
  if (
    addr.startsWith('fe80:') ||
    addr.startsWith('fc') ||
    addr.startsWith('fd')
  ) {
    return true;
  }
  return false;
}

/**
 * Prueba de acreditación estática. El constructor es privado, de modo que la
 * única forma de obtenerla es `acreditar` tras validar URL y confirmación.
 */
export class AcreditacionBaseDesechable {
  private constructor(public readonly url: URL) {}

  get connectionString(): string {
    return this.url.toString();
  }

  static acreditar(
    databaseUrl: string | undefined | null,
    env: Readonly<Record<string, string | undefined>> = process.env,
  ): AcreditacionBaseDesechable {
    if (env.NODE_ENV === 'production') {
      throw new BaseNoAisladaError(
        'NODE_ENV=production no puede ejecutar DDL de prueba.',
      );
    }

    const confirmacion = env[ACK_VARIABLE]?.trim();
    if (confirmacion !== ACK_VALOR) {
      throw new BaseNoAisladaError(
        `falta la confirmación explícita ${ACK_VARIABLE}=${ACK_VALOR}.`,
      );
    }

    const crudo = databaseUrl?.trim();
    if (!crudo) {
      throw new BaseNoAisladaError(
        'falta TAXONOMY_TEST_DATABASE_URL con la base desechable.',
      );
    }

    let url: URL;
    try {
      url = new URL(crudo);
    } catch {
      throw new BaseNoAisladaError('la URL no es válida.');
    }

    if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') {
      throw new BaseNoAisladaError(`protocolo no soportado (${url.protocol}).`);
    }

    if (esHostCompartido(url.hostname)) {
      throw new BaseNoAisladaError(
        `host gestionado o compartido prohibido (${url.hostname}).`,
      );
    }

    if (!esHostDesechable(url.hostname)) {
      throw new BaseNoAisladaError(
        `host no local (${url.hostname}); solo se admite loopback numérico (127.0.0.1/::1), no 0.0.0.0 ni localhost.`,
      );
    }

    return new AcreditacionBaseDesechable(url);
  }
}

export interface ResultadoConsulta<Fila> {
  rows: Fila[];
}

/** Cliente SQL mínimo inyectable para el preflight (facilita pruebas). */
export interface ClienteVerificacion {
  conectar(): Promise<void>;
  consultar<Fila extends Record<string, unknown>>(
    sql: string,
    parametros?: readonly unknown[],
  ): Promise<ResultadoConsulta<Fila>>;
  cerrar(): Promise<void>;
}

export type FabricaClienteVerificacion = (
  connectionString: string,
) => ClienteVerificacion;

function fabricaPorDefecto(connectionString: string): ClienteVerificacion {
  const cliente = new pg.Client({
    connectionString,
    connectionTimeoutMillis: 5000,
    query_timeout: 5000,
    statement_timeout: 5000,
  });
  return {
    conectar: () => cliente.connect(),
    consultar: async <Fila extends Record<string, unknown>>(
      sql: string,
      parametros?: readonly unknown[],
    ) => {
      const resultado = await cliente.query(
        sql,
        parametros ? [...parametros] : undefined,
      );
      return { rows: resultado.rows as unknown as Fila[] };
    },
    cerrar: () => cliente.end(),
  };
}

export interface OpcionesAcreditacionEfimera {
  env?: Readonly<Record<string, string | undefined>>;
  fabricaCliente?: FabricaClienteVerificacion;
}

/**
 * Acreditación en vivo de la instancia creada por el harness. El identificador
 * esperado no se escribe en una base recibida: se configura al iniciar el
 * servidor PostgreSQL propiedad del harness y se coteja con current_setting().
 * Es la ÚNICA credencial aceptada por el DDL destructivo.
 */
export class AcreditacionInstanciaEfimera {
  private constructor(
    private readonly base: AcreditacionBaseDesechable,
    private readonly harnessId: string,
    public readonly direccionServidor: string,
  ) {}

  get connectionString(): string {
    return this.base.connectionString;
  }

  static async acreditar(
    databaseUrl: string | undefined | null,
    opciones: OpcionesAcreditacionEfimera = {},
  ): Promise<AcreditacionInstanciaEfimera> {
    const env = opciones.env ?? process.env;
    const base = AcreditacionBaseDesechable.acreditar(databaseUrl, env);

    const harnessId = env[HARNESS_ID_VARIABLE]?.trim();
    if (!harnessId || !/^[a-f0-9-]{32,}$/i.test(harnessId)) {
      throw new BaseNoAisladaError(
        `falta ${HARNESS_ID_VARIABLE} emitido al aprovisionar la instancia del harness.`,
      );
    }

    const fabrica = opciones.fabricaCliente ?? fabricaPorDefecto;
    const cliente = fabrica(base.connectionString);
    try {
      await cliente.conectar();

      const info = await cliente.consultar<{ direccion: string | null }>(
        'SELECT inet_server_addr()::text AS direccion',
      );
      const direccion = info.rows[0]?.direccion ?? null;
      if (!esDireccionLocalOPrivada(direccion)) {
        throw new BaseNoAisladaError(
          `la instancia no es local ni efímera (inet_server_addr=${direccion ?? 'null'}); se rechaza un posible túnel o servidor remoto.`,
        );
      }

      const identidad = await cliente.consultar<{ harness_id: string | null }>(
        `SELECT current_setting('${HARNESS_ID_SETTING}', true) AS harness_id`,
      );
      if (identidad.rows[0]?.harness_id !== harnessId) {
        throw new BaseNoAisladaError(
          'PostgreSQL no fue iniciado por el harness de pruebas esperado; se rechaza un túnel o instancia ajena.',
        );
      }

      return new AcreditacionInstanciaEfimera(base, harnessId, direccion);
    } catch (error) {
      if (error instanceof BaseNoAisladaError) throw error;
      throw new BaseNoAisladaError(
        'no se pudo verificar la instancia efímera (conexión o configuración del harness inaccesible).',
      );
    } finally {
      await cliente.cerrar().catch(() => undefined);
    }
  }
}
