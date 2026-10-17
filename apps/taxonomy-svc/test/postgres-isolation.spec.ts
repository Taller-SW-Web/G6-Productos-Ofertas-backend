import {
  ACK_VALOR,
  ACK_VARIABLE,
  AcreditacionBaseDesechable,
  AcreditacionInstanciaEfimera,
  BaseNoAisladaError,
  HARNESS_ID_VARIABLE,
  esDireccionLocalOPrivada,
  esHostCompartido,
  esHostDesechable,
} from './postgres-isolation.js';
import type { ClienteVerificacion } from './postgres-isolation.js';
import {
  construirSentenciaDropDdl,
  construirSentenciasDdl,
} from './ddl-taxonomy-prueba.js';

const LOOPBACK = 'postgresql://postgres:postgres@127.0.0.1:5432/taxonomy';
const SUPABASE_POOLER =
  'postgresql://postgres:secreto@aws-0-us-east-1.pooler.supabase.com:5432/postgres';
const SUPABASE_DIRECTO =
  'postgresql://postgres:secreto@db.slzglmtiyrzygpkiuthf.supabase.co:5432/postgres';
const HARNESS_ID = 'a'.repeat(64);

function env(
  extra: Record<string, string | undefined> = {},
): Readonly<Record<string, string | undefined>> {
  return { ...extra };
}

interface OpcionesCliente {
  direccion?: string | null;
  harnessId?: string | null;
  fallaConexion?: boolean;
  fallaConsulta?: boolean;
}

function clienteFalso(opciones: OpcionesCliente): ClienteVerificacion {
  return {
    conectar: () =>
      opciones.fallaConexion
        ? Promise.reject(new Error('conexion rechazada'))
        : Promise.resolve(),
    consultar: (sql: string) => {
      if (opciones.fallaConsulta) {
        return Promise.reject(new Error('relacion no existe'));
      }
      if (sql.includes('inet_server_addr')) {
        return Promise.resolve({
          rows: [{ direccion: opciones.direccion ?? null }],
        });
      }
      if (sql.includes('current_setting')) {
        return Promise.resolve({
          rows:
            opciones.harnessId === null
              ? [{ harness_id: null }]
              : [{ harness_id: opciones.harnessId ?? HARNESS_ID }],
        });
      }
      return Promise.resolve({ rows: [] });
    },
    cerrar: () => Promise.resolve(),
  };
}

function acreditarCon(
  cliente: ClienteVerificacion,
  harnessId: string | undefined = HARNESS_ID,
) {
  return AcreditacionInstanciaEfimera.acreditar(LOOPBACK, {
    env: env({ [ACK_VARIABLE]: ACK_VALOR, [HARNESS_ID_VARIABLE]: harnessId }),
    fabricaCliente: () => cliente,
  });
}

describe('Acreditación de base desechable (seguridad P0)', () => {
  describe('identificación de hosts', () => {
    it('reconoce hosts compartidos/gestionados', () => {
      expect(esHostCompartido('aws-0-us-east-1.pooler.supabase.com')).toBe(
        true,
      );
      expect(esHostCompartido('db.slzglmtiyrzygpkiuthf.supabase.co')).toBe(
        true,
      );
      expect(esHostCompartido('mi-db.rds.amazonaws.com')).toBe(true);
      expect(esHostCompartido('ep-x.us-east-2.aws.neon.tech')).toBe(true);
    });

    it('solo admite loopback numérico como host desechable', () => {
      expect(esHostDesechable('127.0.0.1')).toBe(true);
      expect(esHostDesechable('::1')).toBe(true);
      // Defecto corregido: `0.0.0.0` NO es loopback (es dirección de escucha).
      expect(esHostDesechable('0.0.0.0')).toBe(false);
      // Defecto corregido: `localhost` NO basta (puede resolver a un túnel).
      expect(esHostDesechable('localhost')).toBe(false);
      expect(esHostDesechable('10.0.0.5')).toBe(false);
      expect(esHostDesechable('db.interno.local')).toBe(false);
    });

    it('clasifica direcciones de servidor local/privada vs pública', () => {
      expect(esDireccionLocalOPrivada('127.0.0.1')).toBe(true);
      expect(esDireccionLocalOPrivada('::1')).toBe(true);
      expect(esDireccionLocalOPrivada('10.1.2.3')).toBe(true);
      expect(esDireccionLocalOPrivada('172.16.0.1')).toBe(true);
      expect(esDireccionLocalOPrivada('172.31.255.1')).toBe(true);
      expect(esDireccionLocalOPrivada('192.168.1.1')).toBe(true);
      expect(esDireccionLocalOPrivada('::1/128')).toBe(true);
      expect(esDireccionLocalOPrivada('127.0.0.1/32')).toBe(true);
      expect(esDireccionLocalOPrivada('10.0.0.7/32')).toBe(true);
      expect(esDireccionLocalOPrivada('8.8.8.8')).toBe(false);
      expect(esDireccionLocalOPrivada('203.0.113.10/32')).toBe(false);
      expect(esDireccionLocalOPrivada('172.32.0.1')).toBe(false);
      expect(esDireccionLocalOPrivada(null)).toBe(false);
    });
  });

  describe('acreditación estática', () => {
    it('acepta loopback numérico con confirmación explícita', () => {
      const acreditacion = AcreditacionBaseDesechable.acreditar(
        LOOPBACK,
        env({ [ACK_VARIABLE]: ACK_VALOR }),
      );
      expect(acreditacion.connectionString).toContain('127.0.0.1');
    });

    it('rechaza 0.0.0.0 aunque se confirme explícitamente', () => {
      expect(() =>
        AcreditacionBaseDesechable.acreditar(
          'postgresql://postgres:postgres@0.0.0.0:5432/taxonomy',
          env({ [ACK_VARIABLE]: ACK_VALOR }),
        ),
      ).toThrow(/host no local/i);
    });

    it('rechaza localhost aunque se confirme explícitamente', () => {
      expect(() =>
        AcreditacionBaseDesechable.acreditar(
          'postgresql://postgres:postgres@localhost:5432/taxonomy',
          env({ [ACK_VARIABLE]: ACK_VALOR }),
        ),
      ).toThrow(/host no local/i);
    });

    it('rechaza una URL de Supabase aunque se confirme explícitamente', () => {
      expect(() =>
        AcreditacionBaseDesechable.acreditar(
          SUPABASE_POOLER,
          env({ [ACK_VARIABLE]: ACK_VALOR }),
        ),
      ).toThrow(BaseNoAisladaError);
      expect(() =>
        AcreditacionBaseDesechable.acreditar(
          SUPABASE_DIRECTO,
          env({ [ACK_VARIABLE]: ACK_VALOR }),
        ),
      ).toThrow(/compartido|gestionado/i);
    });

    it('rechaza cuando falta la confirmación explícita', () => {
      expect(() =>
        AcreditacionBaseDesechable.acreditar(LOOPBACK, env()),
      ).toThrow(/TAXONOMY_TEST_DB_ACK/);
    });

    it('rechaza cuando falta la URL', () => {
      expect(() =>
        AcreditacionBaseDesechable.acreditar(
          undefined,
          env({ [ACK_VARIABLE]: ACK_VALOR }),
        ),
      ).toThrow(/TAXONOMY_TEST_DATABASE_URL/);
    });

    it('rechaza protocolos que no son PostgreSQL', () => {
      expect(() =>
        AcreditacionBaseDesechable.acreditar(
          'https://127.0.0.1/taxonomy',
          env({ [ACK_VARIABLE]: ACK_VALOR }),
        ),
      ).toThrow(/protocolo/i);
    });

    it('se niega a acreditar en runtime productivo', () => {
      expect(() =>
        AcreditacionBaseDesechable.acreditar(
          LOOPBACK,
          env({ [ACK_VARIABLE]: ACK_VALOR, NODE_ENV: 'production' }),
        ),
      ).toThrow(/production/i);
    });
  });

  describe('acreditación en vivo de instancia efímera', () => {
    it('acredita cuando el servidor presenta el identificador de harness esperado', async () => {
      const acreditacion = await acreditarCon(
        clienteFalso({ direccion: '127.0.0.1', harnessId: HARNESS_ID }),
      );
      expect(acreditacion.direccionServidor).toBe('127.0.0.1');
    });

    it('rechaza un túnel hacia un servidor remoto (inet_server_addr pública)', async () => {
      await expect(
        acreditarCon(
          clienteFalso({ direccion: '203.0.113.10', harnessId: HARNESS_ID }),
        ),
      ).rejects.toThrow(/túnel|remoto/i);
    });

    it('rechaza cuando el servidor fue iniciado con otro identificador de harness', async () => {
      await expect(
        acreditarCon(
          clienteFalso({ direccion: '127.0.0.1', harnessId: 'b'.repeat(64) }),
        ),
      ).rejects.toThrow(/harness de pruebas esperado/i);
    });

    it('rechaza una instancia local sin identificador del harness', async () => {
      await expect(
        acreditarCon(clienteFalso({ direccion: '127.0.0.1', harnessId: null })),
      ).rejects.toThrow(/harness de pruebas esperado/i);
    });

    it('rechaza cuando falta el identificador emitido por el harness', async () => {
      await expect(
        acreditarCon(clienteFalso({ direccion: '127.0.0.1' }), ''),
      ).rejects.toThrow(/TAXONOMY_TEST_HARNESS_ID/);
    });

    it('rechaza cuando la conexión de verificación falla', async () => {
      await expect(
        acreditarCon(clienteFalso({ fallaConexion: true })),
      ).rejects.toThrow(BaseNoAisladaError);
    });
  });

  describe('DDL destructivo', () => {
    it('exige una acreditación efímera real para construir el DROP', () => {
      expect(() =>
        construirSentenciaDropDdl(
          {} as unknown as AcreditacionInstanciaEfimera,
        ),
      ).toThrow(BaseNoAisladaError);
      expect(() =>
        construirSentenciasDdl({} as unknown as AcreditacionInstanciaEfimera),
      ).toThrow(BaseNoAisladaError);
    });

    it('construye el DROP con una acreditación efímera verificada', async () => {
      const acreditacion = await acreditarCon(
        clienteFalso({ direccion: '127.0.0.1', harnessId: HARNESS_ID }),
      );
      expect(construirSentenciaDropDdl(acreditacion)).toBe(
        'DROP SCHEMA IF EXISTS taxonomy CASCADE',
      );
      expect(construirSentenciasDdl(acreditacion)[0]).toBe(
        'DROP SCHEMA IF EXISTS taxonomy CASCADE',
      );
    });
  });
});
