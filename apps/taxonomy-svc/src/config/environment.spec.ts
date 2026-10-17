import { describe, expect, it } from 'vitest';
import { ConfiguracionInvalidaError, validarEntorno } from './environment.js';

const CLAVE_FALSA = 'clave-de-prueba-no-real';

function entornoValido(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    NODE_ENV: 'test',
    TAXONOMY_SVC_PORT: '3006',
    DATABASE_URL: `postgresql://usuario:${CLAVE_FALSA}@localhost:5432/taxonomy`,
    ...overrides,
  };
}

describe('validarEntorno (#34)', () => {
  it('acepta un entorno completo y tipa los valores', () => {
    const config = validarEntorno(entornoValido());

    expect(config).toEqual({
      nodeEnv: 'test',
      port: 3006,
      databaseUrl: `postgresql://usuario:${CLAVE_FALSA}@localhost:5432/taxonomy`,
    });
    expect(typeof config.port).toBe('number');
  });

  it('usa PORT como alternativa cuando falta TAXONOMY_SVC_PORT', () => {
    const config = validarEntorno(
      entornoValido({ TAXONOMY_SVC_PORT: undefined, PORT: '4567' }),
    );

    expect(config.port).toBe(4567);
  });

  it('rechaza cuando falta NODE_ENV', () => {
    expect(() =>
      validarEntorno(entornoValido({ NODE_ENV: undefined })),
    ).toThrow(ConfiguracionInvalidaError);
  });

  it('rechaza un NODE_ENV no permitido', () => {
    expect(() =>
      validarEntorno(entornoValido({ NODE_ENV: 'staging' })),
    ).toThrowError(/NODE_ENV/);
  });

  it('rechaza cuando falta el puerto', () => {
    expect(() =>
      validarEntorno(
        entornoValido({ TAXONOMY_SVC_PORT: undefined, PORT: undefined }),
      ),
    ).toThrowError(/TAXONOMY_SVC_PORT/);
  });

  it('rechaza un puerto no numérico o fuera de rango', () => {
    expect(() =>
      validarEntorno(entornoValido({ TAXONOMY_SVC_PORT: 'abc' })),
    ).toThrowError(/1 y 65535/);
    expect(() =>
      validarEntorno(entornoValido({ TAXONOMY_SVC_PORT: '70000' })),
    ).toThrowError(/1 y 65535/);
  });

  it('rechaza cuando falta DATABASE_URL', () => {
    expect(() =>
      validarEntorno(entornoValido({ DATABASE_URL: undefined })),
    ).toThrowError(/DATABASE_URL/);
  });

  it('rechaza una DATABASE_URL con protocolo o forma inválida', () => {
    expect(() =>
      validarEntorno(entornoValido({ DATABASE_URL: 'mysql://u:p@host/db' })),
    ).toThrowError(/postgres/);
    expect(() =>
      validarEntorno(entornoValido({ DATABASE_URL: 'no-es-una-url' })),
    ).toThrowError(/postgres/);
  });

  it('acumula los errores de configuración en detalles', () => {
    const error = (() => {
      try {
        validarEntorno({});
        return undefined;
      } catch (capturado) {
        return capturado;
      }
    })();

    expect(error).toBeInstanceOf(ConfiguracionInvalidaError);
    const detalles = (error as ConfiguracionInvalidaError).detalles;
    expect(detalles).toEqual(
      expect.arrayContaining([
        expect.stringContaining('NODE_ENV'),
        expect.stringContaining('TAXONOMY_SVC_PORT'),
        expect.stringContaining('DATABASE_URL'),
      ]),
    );
  });

  it('nunca expone el valor sensible en el mensaje de error', () => {
    const error = (() => {
      try {
        validarEntorno(entornoValido({ DATABASE_URL: `jdbc:${CLAVE_FALSA}` }));
        return undefined;
      } catch (capturado) {
        return capturado;
      }
    })();

    expect(error).toBeInstanceOf(ConfiguracionInvalidaError);
    expect((error as Error).message).not.toContain(CLAVE_FALSA);
  });
});
