import { ConsoleLogger, LoggerService } from '@nestjs/common';

const CLAVES_SENSIBLES =
  /(password|passwd|secret|token|key|pgpassword|authorization|cookie|credential|database[_-]?url|dsn)/i;

const AUTORIZACION =
  /(authorization\s*[:=]\s*)((?:bearer|basic)\s+)?([^\s,;&"'\\]+)/gi;

const ENCABEZADOS_COOKIE = /((?:set-cookie|cookie)\s*[:=]\s*)([^\r\n]*)/gi;

const CLAVES_SENSIBLES_JSON =
  'password|passwd|pwd|secret|token|api[_-]?key|apikey|authorization|cookie|set-cookie|credential|credentials|database[_-]?url|dsn|pgpassword';

const JSON_SENSIBLE = new RegExp(
  `("(?:[^"\\\\]*(?:${CLAVES_SENSIBLES_JSON})[^"\\\\]*)"\\s*:\\s*")((?:[^"\\\\]|\\\\.)*)(")`,
  'gi',
);

const PAR_CLAVE_VALOR =
  /([A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|token|key|credential|dsn|pgpassword)[A-Za-z0-9_.-]*\s*[=:]\s*)([^\s,;&]+)/gi;

const CREDENCIALES_EN_URL = /(:\/\/[^/@\s:]+:)[^@/\s]+(@)/g;

const PROFUNDIDAD_MAXIMA = 6;
const MASCARA = '***';
const RECORTE_PROFUNDIDAD = '[recortado]';

function esObjetoPlano(valor: unknown): valor is Record<string, unknown> {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor);
}

function sanitizarTexto(texto: string): string {
  return texto
    .replace(AUTORIZACION, `$1$2${MASCARA}`)
    .replace(ENCABEZADOS_COOKIE, `$1${MASCARA}`)
    .replace(JSON_SENSIBLE, `$1${MASCARA}$3`)
    .replace(PAR_CLAVE_VALOR, `$1${MASCARA}`)
    .replace(CREDENCIALES_EN_URL, `$1${MASCARA}$2`);
}

export function sanitizar(valor: unknown, profundidad = 0): unknown {
  if (typeof valor === 'string') {
    return sanitizarTexto(valor);
  }
  if (Array.isArray(valor)) {
    if (profundidad >= PROFUNDIDAD_MAXIMA) {
      return RECORTE_PROFUNDIDAD;
    }
    return valor.map((item) => sanitizar(item, profundidad + 1));
  }
  if (esObjetoPlano(valor)) {
    if (profundidad >= PROFUNDIDAD_MAXIMA) {
      return RECORTE_PROFUNDIDAD;
    }
    const resultado: Record<string, unknown> = {};
    for (const [clave, item] of Object.entries(valor)) {
      resultado[clave] = CLAVES_SENSIBLES.test(clave)
        ? MASCARA
        : sanitizar(item, profundidad + 1);
    }
    return resultado;
  }
  return valor;
}

function sanitizarArgumentos(argumentos: unknown[]): unknown[] {
  return argumentos.map((argumento) => sanitizar(argumento));
}

export class SanitizedLogger implements LoggerService {
  constructor(private readonly destino: LoggerService = new ConsoleLogger()) {}

  log(mensaje: unknown, ...opcionales: unknown[]): void {
    this.destino.log(sanitizar(mensaje), ...sanitizarArgumentos(opcionales));
  }

  error(mensaje: unknown, ...opcionales: unknown[]): void {
    this.destino.error(sanitizar(mensaje), ...sanitizarArgumentos(opcionales));
  }

  warn(mensaje: unknown, ...opcionales: unknown[]): void {
    this.destino.warn(sanitizar(mensaje), ...sanitizarArgumentos(opcionales));
  }

  debug(mensaje: unknown, ...opcionales: unknown[]): void {
    this.destino.debug?.(
      sanitizar(mensaje),
      ...sanitizarArgumentos(opcionales),
    );
  }

  verbose(mensaje: unknown, ...opcionales: unknown[]): void {
    this.destino.verbose?.(
      sanitizar(mensaje),
      ...sanitizarArgumentos(opcionales),
    );
  }

  fatal(mensaje: unknown, ...opcionales: unknown[]): void {
    this.destino.fatal?.(
      sanitizar(mensaje),
      ...sanitizarArgumentos(opcionales),
    );
  }
}
