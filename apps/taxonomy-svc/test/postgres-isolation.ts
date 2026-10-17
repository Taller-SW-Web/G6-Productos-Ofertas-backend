/**
 * Acreditación obligatoria de bases PostgreSQL desechables para pruebas.
 *
 * Las pruebas de integración de taxonomy ejecutan DDL destructivo
 * (`DROP SCHEMA IF EXISTS taxonomy CASCADE`). Este módulo garantiza que ese
 * DDL solo pueda construirse/ejecutarse contra una base explícitamente
 * identificada como desechable de prueba y accesible por loopback.
 *
 * No basta con que la variable se llame `TAXONOMY_TEST_DATABASE_URL`: se exige
 * una confirmación explícita independiente (`TAXONOMY_TEST_DB_ACK`) y se
 * rechaza cualquier host gestionado o compartido (p.ej. Supabase, RDS).
 */

export const ACK_VARIABLE = 'TAXONOMY_TEST_DB_ACK';
export const ACK_VALOR = 'desechable-aislado';

export class BaseNoAisladaError extends Error {
  constructor(detalle: string) {
    super('Base de datos no acreditada como desechable de prueba: ' + detalle);
    this.name = 'BaseNoAisladaError';
  }
}

const HOSTS_LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);

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

/** Host local (loopback), único destino admitido para DDL destructivo. */
export function esHostDesechable(host: string): boolean {
  return HOSTS_LOOPBACK.has(normalizarHost(host));
}

/**
 * Prueba de acreditación. La clase es la única fábrica posible (constructor
 * privado), de modo que `construirSentenciasDdl` solo recibe instancias
 * obtenidas tras validar la URL y la confirmación explícita.
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
        `host no local (${url.hostname}); solo se admite loopback (localhost/127.0.0.1/::1).`,
      );
    }

    return new AcreditacionBaseDesechable(url);
  }
}
