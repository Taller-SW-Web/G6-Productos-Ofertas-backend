export type Entorno = 'development' | 'test' | 'production';

export interface TaxonomyEnv {
  nodeEnv: Entorno;
  port: number;
  databaseUrl: string;
}

export class ConfiguracionInvalidaError extends Error {
  public readonly detalles: string[];

  constructor(detalles: string[]) {
    super('Configuracion de entorno invalida: ' + detalles.join(' '));
    this.name = 'ConfiguracionInvalidaError';
    this.detalles = detalles;
  }
}

const ENTORNOS_VALIDOS: readonly Entorno[] = [
  'development',
  'test',
  'production',
];

function leerEntorno(
  env: Record<string, string | undefined>,
  errores: string[],
): Entorno | undefined {
  const crudo = env.NODE_ENV?.trim();
  if (!crudo) {
    errores.push('NODE_ENV es obligatorio.');
    return undefined;
  }
  if (!ENTORNOS_VALIDOS.includes(crudo as Entorno)) {
    errores.push(
      'NODE_ENV debe ser uno de: ' + ENTORNOS_VALIDOS.join(', ') + '.',
    );
    return undefined;
  }
  return crudo as Entorno;
}

function leerPuerto(
  env: Record<string, string | undefined>,
  errores: string[],
): number | undefined {
  const crudo = (env.TAXONOMY_SVC_PORT ?? env.PORT)?.trim();
  if (!crudo) {
    errores.push('TAXONOMY_SVC_PORT (o PORT) es obligatorio.');
    return undefined;
  }
  const puerto = Number(crudo);
  if (!Number.isInteger(puerto) || puerto < 1 || puerto > 65535) {
    errores.push('TAXONOMY_SVC_PORT/PORT debe ser un entero entre 1 y 65535.');
    return undefined;
  }
  return puerto;
}

function esUrlPostgresValida(valor: string): boolean {
  try {
    const url = new URL(valor);
    const protocoloValido =
      url.protocol === 'postgresql:' || url.protocol === 'postgres:';
    return (
      protocoloValido &&
      url.hostname.length > 0 &&
      url.pathname.replace(/^\//, '').length > 0
    );
  } catch {
    return false;
  }
}

function leerDatabaseUrl(
  env: Record<string, string | undefined>,
  errores: string[],
): string | undefined {
  const crudo = env.DATABASE_URL?.trim();
  if (!crudo) {
    errores.push('DATABASE_URL es obligatoria.');
    return undefined;
  }
  if (!esUrlPostgresValida(crudo)) {
    errores.push(
      'DATABASE_URL debe ser una URL postgresql:// o postgres:// valida con host y base de datos.',
    );
    return undefined;
  }
  return crudo;
}

export function validarEntorno(
  env: Record<string, string | undefined>,
): TaxonomyEnv {
  const errores: string[] = [];
  const nodeEnv = leerEntorno(env, errores);
  const port = leerPuerto(env, errores);
  const databaseUrl = leerDatabaseUrl(env, errores);

  if (!nodeEnv || port === undefined || !databaseUrl) {
    throw new ConfiguracionInvalidaError(
      errores.length > 0 ? errores : ['Configuracion de entorno incompleta.'],
    );
  }

  return { nodeEnv, port, databaseUrl };
}
