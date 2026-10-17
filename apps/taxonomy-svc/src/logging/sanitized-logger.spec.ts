import { LoggerService } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { SanitizedLogger, sanitizar } from './sanitized-logger.js';

const CLAVE_FALSA = 'clave-de-prueba-no-real';

class SinkCapturador implements LoggerService {
  readonly registros: unknown[][] = [];

  log(...args: unknown[]): void {
    this.registros.push(args);
  }

  error(...args: unknown[]): void {
    this.registros.push(args);
  }

  warn(...args: unknown[]): void {
    this.registros.push(args);
  }

  debug(...args: unknown[]): void {
    this.registros.push(args);
  }

  verbose(...args: unknown[]): void {
    this.registros.push(args);
  }

  fatal(...args: unknown[]): void {
    this.registros.push(args);
  }

  volcado(): string {
    return JSON.stringify(this.registros);
  }
}

describe('sanitizar (#34)', () => {
  it('enmascara claves sensibles en objetos planos', () => {
    const resultado = sanitizar({
      usuario: 'taxonomy_dev_login',
      PGPASSWORD: CLAVE_FALSA,
      apiKey: CLAVE_FALSA,
    }) as Record<string, unknown>;

    expect(resultado.usuario).toBe('taxonomy_dev_login');
    expect(resultado.PGPASSWORD).toBe('***');
    expect(resultado.apiKey).toBe('***');
  });

  it('enmascara claves sensibles en objetos anidados y arreglos', () => {
    const resultado = sanitizar({
      conexion: { host: 'localhost', password: CLAVE_FALSA },
      lista: [{ token: CLAVE_FALSA }],
    });

    expect(JSON.stringify(resultado)).not.toContain(CLAVE_FALSA);
    expect(JSON.stringify(resultado)).toContain('localhost');
  });

  it('enmascara pares clave=valor dentro de cadenas', () => {
    const resultado = sanitizar(
      `conectando password=${CLAVE_FALSA} host=localhost`,
    ) as string;

    expect(resultado).not.toContain(CLAVE_FALSA);
    expect(resultado).toContain('host=localhost');
  });

  it('enmascara credenciales embebidas en URLs', () => {
    const resultado = sanitizar(
      `postgresql://usuario:${CLAVE_FALSA}@localhost:5432/taxonomy`,
    ) as string;

    expect(resultado).not.toContain(CLAVE_FALSA);
    expect(resultado).toContain('usuario:***@localhost');
  });

  it('recorta estructuras demasiado profundas sin lanzar', () => {
    const profundo: Record<string, unknown> = {};
    let actual = profundo;
    for (let i = 0; i < 20; i += 1) {
      const siguiente: Record<string, unknown> = {};
      actual.nivel = siguiente;
      actual = siguiente;
    }

    expect(() => sanitizar(profundo)).not.toThrow();
  });
});

describe('SanitizedLogger (#34)', () => {
  it('delega en el destino sin exponer secretos', () => {
    const sink = new SinkCapturador();
    const logger = new SanitizedLogger(sink);

    logger.log('Configuracion de arranque validada', {
      entorno: 'test',
      puerto: 3006,
      DATABASE_URL: `postgresql://usuario:${CLAVE_FALSA}@localhost:5432/taxonomy`,
    });

    expect(sink.volcado()).not.toContain(CLAVE_FALSA);
    expect(sink.volcado()).toContain('test');
    expect(sink.volcado()).toContain('3006');
    expect(sink.volcado()).toContain('***');
  });

  it('sanitiza también el mensaje principal', () => {
    const sink = new SinkCapturador();
    const logger = new SanitizedLogger(sink);

    logger.log(`conexion postgresql://usuario:${CLAVE_FALSA}@host/db`);

    expect(sink.volcado()).not.toContain(CLAVE_FALSA);
  });

  it('soporta todos los niveles requeridos por LoggerService', () => {
    const sink = new SinkCapturador();
    const logger = new SanitizedLogger(sink);

    logger.error('error', { token: CLAVE_FALSA });
    logger.warn('warn', { secret: CLAVE_FALSA });
    logger.debug('debug', { password: CLAVE_FALSA });
    logger.verbose('verbose', { pgpassword: CLAVE_FALSA });
    logger.fatal('fatal', { credential: CLAVE_FALSA });

    expect(sink.registros).toHaveLength(5);
    expect(sink.volcado()).not.toContain(CLAVE_FALSA);
  });
});
