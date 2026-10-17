import { LoggerService } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { crearAplicacion, readHttpConfig } from './bootstrap.js';
import { ConfiguracionInvalidaError } from './config/environment.js';

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

  volcado(): string {
    return JSON.stringify(this.registros);
  }
}

function entornoValido(): Record<string, string | undefined> {
  return {
    NODE_ENV: 'test',
    TAXONOMY_SVC_PORT: '3006',
    DATABASE_URL: `postgresql://usuario:${CLAVE_FALSA}@localhost:5432/taxonomy`,
  };
}

describe('Taxonomy bootstrap configuration reconciled with López', () => {
  it('defaults to loopback and supports Docker binding and PORT fallback', () => {
    expect(readHttpConfig({})).toEqual({ host: '127.0.0.1', port: 3006 });
    expect(
      readHttpConfig({
        NODE_ENV: 'production',
        TAXONOMY_SVC_HOST: '0.0.0.0',
        PORT: '3016',
      }),
    ).toEqual({ host: '0.0.0.0', port: 3016 });
  });

  it.each(['0', '65536', 'abc', '1.5', ' 3006', 'Infinity'])(
    'rejects invalid port %s',
    (value) => {
      expect(() => readHttpConfig({ TAXONOMY_SVC_PORT: value })).toThrow();
    },
  );

  it('rejects invalid environment without returning its value', () => {
    expect(() => readHttpConfig({ NODE_ENV: 'private-secret' })).toThrow(
      'Configuración HTTP taxonomy inválida',
    );
  });
});

describe('crearAplicacion — fail-closed (#34)', () => {
  it('rechaza el arranque cuando falta DATABASE_URL', async () => {
    const env = entornoValido();
    delete env.DATABASE_URL;

    await expect(crearAplicacion({ env })).rejects.toBeInstanceOf(
      ConfiguracionInvalidaError,
    );
  });

  it('rechaza el arranque cuando DATABASE_URL es inválida', async () => {
    await expect(
      crearAplicacion({
        env: { ...entornoValido(), DATABASE_URL: 'no-valido' },
      }),
    ).rejects.toBeInstanceOf(ConfiguracionInvalidaError);
  });

  it('crea la aplicación con un entorno válido y registra sin exponer secretos', async () => {
    const sink = new SinkCapturador();

    const { app, env } = await crearAplicacion({
      env: entornoValido(),
      logger: sink,
    });

    try {
      expect(app).toBeDefined();
      expect(env.port).toBe(3006);
      const logs = sink.volcado();
      expect(logs.length).toBeGreaterThan(0);
      expect(logs).toContain('test');
      expect(logs).toContain('3006');
      expect(logs).not.toContain(CLAVE_FALSA);
      expect(logs).not.toContain('DATABASE_URL');
      expect(logs).not.toContain('postgresql://');
    } finally {
      await app.close();
    }
  });

  it('rechaza crearAplicacion en entorno production para impedir el uso de la fábrica alternativa sin TLS e identidad', async () => {
    await expect(
      crearAplicacion({
        env: { ...entornoValido(), NODE_ENV: 'production' },
      }),
    ).rejects.toThrow(ConfiguracionInvalidaError);
  });
});
