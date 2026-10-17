import { HttpStatus } from '@nestjs/common';
import { ProblemDetailsException } from '../errors/taxonomy.errors.js';
import {
  DrizzleTaxonomyRepository,
  aCategoriaRow,
  aMarcaRow,
  esFalloDeConexion,
} from './drizzle-taxonomy.repository.js';
import type {
  FilaCategoriaDb,
  FilaMarcaDb,
  TaxonomyDb,
} from './drizzle-taxonomy.repository.js';
import { categorias, marcas } from './taxonomy.schema.js';

function dbFalso(parcial: Record<string, unknown>): TaxonomyDb {
  return parcial as unknown as TaxonomyDb;
}

function dbQueDevuelveFilas(filas: unknown[]): TaxonomyDb {
  return dbFalso({
    select: () => ({
      from: () => ({
        where: () => Promise.resolve(filas),
      }),
    }),
  });
}

interface ConsultaReadiness {
  columnas: string[];
  tabla: unknown;
}

function dbReadiness(
  capturas: ConsultaReadiness[],
  error?: unknown,
): TaxonomyDb {
  return dbFalso({
    select: (columnas: Record<string, unknown>) => ({
      from: (tabla: unknown) => ({
        where: () => ({
          limit: () => {
            capturas.push({ columnas: Object.keys(columnas), tabla });
            return error ? Promise.reject(error) : Promise.resolve([]);
          },
        }),
      }),
    }),
  });
}

describe('DrizzleTaxonomyRepository (#35)', () => {
  describe('mapeo de filas', () => {
    it('aCategoriaRow mapea columnas y fija estado ACTIVO', () => {
      const fila: FilaCategoriaDb = {
        id: '49a1dbd0-666d-0d43-6d1e-1053d4564455',
        nombre: 'Calzado',
        categoria_padre_id: null,
      };

      expect(aCategoriaRow(fila)).toEqual({
        id: '49a1dbd0-666d-0d43-6d1e-1053d4564455',
        nombre: 'Calzado',
        categoria_padre_id: null,
        estado: 'ACTIVO',
      });
    });

    it('aCategoriaRow conserva el padre cuando existe', () => {
      const fila: FilaCategoriaDb = {
        id: 'b',
        nombre: 'Sub',
        categoria_padre_id: 'a',
      };

      expect(aCategoriaRow(fila).categoria_padre_id).toBe('a');
    });

    it('aMarcaRow mapea columnas y normaliza nulos', () => {
      const fila: FilaMarcaDb = {
        id: '380d9fe0-0290-580a-95e6-6bcd378b9b92',
        nombre: 'Marathon',
        descripcion: null,
        pais_origen_iso: 'EC',
        logo_url: null,
      };

      expect(aMarcaRow(fila)).toEqual({
        id: '380d9fe0-0290-580a-95e6-6bcd378b9b92',
        nombre: 'Marathon',
        descripcion: null,
        pais_origen_iso: 'EC',
        logo_url: null,
        estado: 'ACTIVO',
      });
    });
  });

  describe('clasificacion de errores de conexion', () => {
    it('reconoce codigos de red y de indisponibilidad de Postgres', () => {
      expect(esFalloDeConexion({ code: 'ECONNREFUSED' })).toBe(true);
      expect(esFalloDeConexion({ code: '57P03' })).toBe(true);
      expect(esFalloDeConexion({ code: '08006' })).toBe(true);
    });

    it('no clasifica errores logicos ni valores no estructurados', () => {
      expect(esFalloDeConexion(new Error('syntax error'))).toBe(false);
      expect(esFalloDeConexion({ code: '42P01' })).toBe(false);
      expect(esFalloDeConexion({ code: 123 })).toBe(false);
      expect(esFalloDeConexion(null)).toBe(false);
      expect(esFalloDeConexion('ECONNREFUSED')).toBe(false);
    });

    it('detecta el codigo cuando viene anidado en AggregateError o cause', () => {
      const agregado = Object.assign(new Error('aggregate'), {
        errors: [{ code: 'ECONNREFUSED' }],
      });
      const conCausa = Object.assign(new Error('wrapper'), {
        cause: { code: '57P03' },
      });

      expect(esFalloDeConexion(agregado)).toBe(true);
      expect(esFalloDeConexion(conCausa)).toBe(true);
    });
  });

  describe('consultas', () => {
    it('findCategoriasActivas mapea las filas devueltas', async () => {
      const repo = new DrizzleTaxonomyRepository(
        dbQueDevuelveFilas([
          { id: 'c1', nombre: 'Calzado', categoria_padre_id: null },
        ]),
      );

      await expect(repo.findCategoriasActivas()).resolves.toEqual([
        {
          id: 'c1',
          nombre: 'Calzado',
          categoria_padre_id: null,
          estado: 'ACTIVO',
        },
      ]);
    });

    it('findMarcasActivas mapea las filas devueltas', async () => {
      const repo = new DrizzleTaxonomyRepository(
        dbQueDevuelveFilas([
          {
            id: 'm1',
            nombre: 'Marathon',
            descripcion: 'Marca',
            pais_origen_iso: 'EC',
            logo_url: 'https://example.com/logo.png',
          },
        ]),
      );

      await expect(repo.findMarcasActivas()).resolves.toEqual([
        {
          id: 'm1',
          nombre: 'Marathon',
          descripcion: 'Marca',
          pais_origen_iso: 'EC',
          logo_url: 'https://example.com/logo.png',
          estado: 'ACTIVO',
        },
      ]);
    });

    it('traduce un fallo de conexion a 503 SERVICIO_NO_DISPONIBLE', async () => {
      const repo = new DrizzleTaxonomyRepository(
        dbFalso({
          select: () => ({
            from: () => ({
              where: () => Promise.reject({ code: 'ECONNREFUSED' }),
            }),
          }),
        }),
      );

      const error = await repo.findCategoriasActivas().catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ProblemDetailsException);
      expect((error as ProblemDetailsException).getStatus()).toBe(
        HttpStatus.SERVICE_UNAVAILABLE,
      );
      expect((error as ProblemDetailsException).problem.code).toBe(
        'SERVICIO_NO_DISPONIBLE',
      );
    });

    it('repropaga los errores ajenos a la conexion para que el filtro los sanitice', async () => {
      const original = new Error(
        'relation "taxonomy.categories" does not exist',
      );
      const repo = new DrizzleTaxonomyRepository(
        dbFalso({
          select: () => ({
            from: () => ({ where: () => Promise.reject(original) }),
          }),
        }),
      );

      await expect(repo.findCategoriasActivas()).rejects.toBe(original);
    });
  });

  describe('readiness', () => {
    it('consulta columnas explícitas de taxonomy.categories y taxonomy.brands', async () => {
      const capturas: ConsultaReadiness[] = [];
      const repo = new DrizzleTaxonomyRepository(dbReadiness(capturas));

      await expect(repo.verificarReadiness()).resolves.toBeUndefined();

      expect(capturas).toHaveLength(2);
      expect(capturas[0].tabla).toBe(categorias);
      expect(capturas[0].columnas).toEqual([
        'id',
        'nombre',
        'categoria_padre_id',
        'estado',
      ]);
      expect(capturas[1].tabla).toBe(marcas);
      expect(capturas[1].columnas).toEqual([
        'id',
        'nombre',
        'descripcion',
        'pais_origen_iso',
        'logo_url',
        'estado',
      ]);
    });

    it('responde 503 cuando la base no responde', async () => {
      const repo = new DrizzleTaxonomyRepository(
        dbReadiness([], { code: '57P03' }),
      );

      const error = await repo.verificarReadiness().catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ProblemDetailsException);
      expect((error as ProblemDetailsException).getStatus()).toBe(
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    });

    it('responde 503 si el usuario no tiene permisos de lectura (42501)', async () => {
      const repo = new DrizzleTaxonomyRepository(
        dbReadiness([], {
          code: '42501',
          message: 'permission denied for table categories',
        }),
      );

      const error = await repo.verificarReadiness().catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ProblemDetailsException);
      expect((error as ProblemDetailsException).getStatus()).toBe(
        HttpStatus.SERVICE_UNAVAILABLE,
      );
      expect((error as ProblemDetailsException).problem.code).toBe(
        'SERVICIO_NO_DISPONIBLE',
      );
    });

    it('responde 503 si falta la columna logo_url en taxonomy.brands', async () => {
      const capturas: ConsultaReadiness[] = [];
      const repo = new DrizzleTaxonomyRepository(
        dbReadiness(capturas, {
          code: '42703',
          message: 'column brands.logo_url does not exist',
        }),
      );

      const error = await repo.verificarReadiness().catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ProblemDetailsException);
      expect((error as ProblemDetailsException).getStatus()).toBe(
        HttpStatus.SERVICE_UNAVAILABLE,
      );
      expect((error as ProblemDetailsException).problem.code).toBe(
        'SERVICIO_NO_DISPONIBLE',
      );
    });

    it('responde 503 cuando una tabla de taxonomía falla', async () => {
      const repo = new DrizzleTaxonomyRepository(
        dbReadiness([], {
          code: '42P01',
          message: 'relation "taxonomy.categories" does not exist',
        }),
      );

      const error = await repo.verificarReadiness().catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ProblemDetailsException);
      expect((error as ProblemDetailsException).getStatus()).toBe(
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    });
  });

  describe('transacciones', () => {
    it('delega en db.transaction y propaga el resultado', async () => {
      const tx = { marcador: 'tx' };
      const repo = new DrizzleTaxonomyRepository(
        dbFalso({
          transaction: (operacion: (tx: unknown) => Promise<unknown>) =>
            operacion(tx),
        }),
      );

      const resultado = await repo.enTransaccion(async (actual) => {
        expect(actual).toBe(tx);
        return 'hecho';
      });

      expect(resultado).toBe('hecho');
    });

    it('propaga el error para que la transaccion haga rollback', async () => {
      const fallo = new Error('rollback');
      const repo = new DrizzleTaxonomyRepository(
        dbFalso({
          transaction: async () => {
            throw fallo;
          },
        }),
      );

      await expect(repo.enTransaccion(async () => 'nunca')).rejects.toBe(fallo);
    });
  });

  describe('cierre de conexion', () => {
    it('invoca el cierre registrado al apagar la aplicacion', async () => {
      let cerrado = false;
      const repo = new DrizzleTaxonomyRepository(dbFalso({}), async () => {
        cerrado = true;
      });

      await repo.onApplicationShutdown();

      expect(cerrado).toBe(true);
    });
  });
});
