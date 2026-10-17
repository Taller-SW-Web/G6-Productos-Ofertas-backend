import {
  ACK_VALOR,
  ACK_VARIABLE,
  AcreditacionBaseDesechable,
  BaseNoAisladaError,
  esHostCompartido,
  esHostDesechable,
} from './postgres-isolation.js';
import {
  construirSentenciaDropDdl,
  construirSentenciasDdl,
} from './ddl-taxonomy-prueba.js';

const LOOPBACK = 'postgresql://postgres:postgres@127.0.0.1:5432/taxonomy';
const SUPABASE_POOLER =
  'postgresql://postgres:secreto@aws-0-us-east-1.pooler.supabase.com:5432/postgres';
const SUPABASE_DIRECTO =
  'postgresql://postgres:secreto@db.slzglmtiyrzygpkiuthf.supabase.co:5432/postgres';

function env(extra: Record<string, string | undefined> = {}) {
  return { ...extra } as Readonly<Record<string, string | undefined>>;
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

    it('no marca los hosts loopback como compartidos', () => {
      expect(esHostCompartido('localhost')).toBe(false);
      expect(esHostCompartido('127.0.0.1')).toBe(false);
      expect(esHostCompartido('::1')).toBe(false);
    });

    it('solo admite loopback como host desechable', () => {
      expect(esHostDesechable('127.0.0.1')).toBe(true);
      expect(esHostDesechable('localhost')).toBe(true);
      expect(esHostDesechable('10.0.0.5')).toBe(false);
      expect(esHostDesechable('db.interno.local')).toBe(false);
    });
  });

  describe('acreditar', () => {
    it('acepta loopback con confirmación explícita', () => {
      const acreditacion = AcreditacionBaseDesechable.acreditar(
        LOOPBACK,
        env({ [ACK_VARIABLE]: ACK_VALOR }),
      );
      expect(acreditacion.connectionString).toContain('127.0.0.1');
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

    it('rechaza un host no local aunque no sea un proveedor conocido', () => {
      expect(() =>
        AcreditacionBaseDesechable.acreditar(
          'postgresql://postgres:postgres@10.20.30.40:5432/taxonomy',
          env({ [ACK_VARIABLE]: ACK_VALOR }),
        ),
      ).toThrow(/no local/i);
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

  describe('DDL destructivo', () => {
    it('exige una acreditación real para construir el DROP', () => {
      expect(() =>
        construirSentenciaDropDdl({} as unknown as AcreditacionBaseDesechable),
      ).toThrow(BaseNoAisladaError);
      expect(() =>
        construirSentenciasDdl({} as unknown as AcreditacionBaseDesechable),
      ).toThrow(BaseNoAisladaError);
    });

    it('construye el DROP con una acreditación válida', () => {
      const acreditacion = AcreditacionBaseDesechable.acreditar(
        LOOPBACK,
        env({ [ACK_VARIABLE]: ACK_VALOR }),
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
