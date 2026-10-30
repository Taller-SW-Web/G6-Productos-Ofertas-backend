import { randomUUID } from 'node:crypto';
import { HttpStatus } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types';
import { ProblemDetailsException } from './../src/errors/taxonomy.errors.js';
import { TaxonomyInvariantError } from './../src/domain/taxonomy-invariants.js';
import { crearRepositorioDrizzle } from './../src/persistence/persistence.providers.js';
import {
  categorySeo,
  categorias,
  characteristicValues,
  characteristics,
  esquemaTaxonomia,
  marcas,
  productTypeCharacteristics,
  productTypes,
  outbox,
} from './../src/persistence/taxonomy.schema.js';
import type { TaxonomyDb } from './../src/persistence/drizzle-taxonomy.repository.js';
import type { DrizzleTaxonomyRepository } from './../src/persistence/drizzle-taxonomy.repository.js';
import { TaxonomyWriteRepository } from './../src/persistence/taxonomy-write.repository.js';
import { TaxonomyWriteService } from './../src/taxonomy-write.service.js';
import {
  PostgresTaxonomyRepository,
  type TaxonomyDataSource,
} from './../src/postgres-taxonomy.repository.js';
import { TAXONOMY_REPOSITORY } from './../src/taxonomy.repository.js';
import { TaxonomySvcModule } from './../src/taxonomy-svc.module.js';
import { AcreditacionInstanciaEfimera } from './postgres-isolation.js';
import {
  PASSWORD_APP,
  ROL_APP,
  construirSentenciaDropDdl,
  construirSentenciasDdl,
  construirSentenciasSemilla,
} from './ddl-taxonomy-prueba.js';

const URL_BASE = process.env.TAXONOMY_TEST_DATABASE_URL?.trim();
const describeIntegracion = URL_BASE ? describe : describe.skip;

function codigoDe(error: unknown): string | undefined {
  return error instanceof TaxonomyInvariantError ? error.code : undefined;
}

function urlConRol(base: string, usuario: string, password: string): string {
  const url = new URL(base);
  url.username = usuario;
  url.password = password;
  return url.toString();
}

function adaptadorRuntime(pool: Pool): TaxonomyDataSource {
  let db: NodePgDatabase | undefined;
  return {
    read: <T>(consulta: (conexion: NodePgDatabase) => Promise<T>) => {
      db ??= drizzle(pool);
      return consulta(db);
    },
    verifyIdentity: () => Promise.resolve(),
  };
}

describeIntegracion(
  'Persistencia Drizzle contra Postgres aislado (#35)',
  () => {
    let admin: Pool;
    let app: Pool;
    let dbApp: TaxonomyDb;
    let repo: DrizzleTaxonomyRepository;
    let writes: TaxonomyWriteRepository;
    let urlApp: string;
    let acreditacion: AcreditacionInstanciaEfimera;

    async function levantarAppNest(): Promise<INestApplication<App>> {
      const moduleFixture = await Test.createTestingModule({
        imports: [TaxonomySvcModule.forRoot({ databaseUrl: urlApp })],
      }).compile();
      const creada: INestApplication<App> =
        moduleFixture.createNestApplication();
      await creada.init();
      return creada;
    }

    beforeAll(async () => {
      acreditacion = await AcreditacionInstanciaEfimera.acreditar(URL_BASE);
      const urlBase = acreditacion.connectionString;
      urlApp = urlConRol(urlBase, ROL_APP, PASSWORD_APP);
      admin = new Pool({ connectionString: urlBase });
      for (const sentencia of construirSentenciasDdl(acreditacion)) {
        await admin.query(sentencia);
      }
      for (const sentencia of construirSentenciasSemilla()) {
        await admin.query(sentencia);
      }
      app = new Pool({ connectionString: urlApp });
      dbApp = drizzle(app, { schema: esquemaTaxonomia });
      repo = crearRepositorioDrizzle(urlApp);
      writes = new TaxonomyWriteRepository(repo);
    });

    afterAll(async () => {
      try {
        await repo?.onApplicationShutdown();
      } catch {
        /* cierre defensivo */
      }
      try {
        await app?.end();
      } catch {
        /* cierre defensivo */
      }
      try {
        await admin?.query(
          `GRANT SELECT ON ALL TABLES IN SCHEMA taxonomy TO ${ROL_APP}`,
        );
      } catch {
        /* restauración defensiva si el esquema existe */
      }
      try {
        if (acreditacion) {
          await admin?.query(construirSentenciaDropDdl(acreditacion));
        }
      } catch {
        /* limpieza defensiva */
      }
      try {
        await admin?.end();
      } catch {
        /* limpieza defensiva */
      }
    });

    it('findCategoriasActivas devuelve solo ACTIVO con el mapeo esperado', async () => {
      const filas = await repo.findCategoriasActivas();

      expect(filas.map((f) => f.nombre).sort()).toEqual([
        'Calzado',
        'Zapatillas',
      ]);
      expect(filas.every((f) => f.estado === 'ACTIVO')).toBe(true);
      const zapatillas = filas.find((f) => f.nombre === 'Zapatillas');
      expect(zapatillas?.categoria_padre_id).toBe(
        '11111111-1111-4111-8111-111111111111',
      );
    });

    it('findMarcasActivas devuelve solo ACTIVO y mapea sus columnas', async () => {
      const filas = await repo.findMarcasActivas();

      expect(filas).toEqual([
        {
          id: '44444444-4444-4444-8444-444444444444',
          nombre: 'Marathon',
          descripcion: 'Marca ecuatoriana',
          pais_origen_iso: 'EC',
          logo_url: null,
          estado: 'ACTIVO',
        },
      ]);
    });

    it('el esquema Drizzle coincide con las columnas reales de la base', async () => {
      const filas = await dbApp
        .select({
          nombre: marcas.nombre,
          normalizado: marcas.nombreNormalizado,
          pais: marcas.paisOrigenIso,
          version: marcas.taxonomyVersion,
          estado: marcas.estado,
        })
        .from(marcas)
        .orderBy(marcas.nombre);

      expect(filas).toEqual([
        {
          nombre: 'Marathon',
          normalizado: 'marathon',
          pais: 'EC',
          version: 0,
          estado: 'ACTIVO',
        },
        {
          nombre: 'Retirada',
          normalizado: 'retirada',
          pais: null,
          version: 0,
          estado: 'INACTIVO',
        },
      ]);
    });

    it('enTransaccion confirma los cambios al hacer commit', async () => {
      await repo.enTransaccion(async (tx) => {
        await tx
          .insert(marcas)
          .values({ nombre: 'Transaccion Commit', paisOrigenIso: 'EC' });
      });

      const { rows } = await admin.query<{ nombre: string }>(
        "SELECT nombre FROM taxonomy.brands WHERE nombre = 'Transaccion Commit'",
      );
      expect(rows).toHaveLength(1);
    });

    it('enTransaccion revierte los cambios si la operacion falla', async () => {
      await expect(
        repo.enTransaccion(async (tx) => {
          await tx
            .insert(marcas)
            .values({ nombre: 'Transaccion Rollback', paisOrigenIso: 'EC' });
          throw new Error('rollback intencional');
        }),
      ).rejects.toThrow('rollback intencional');

      const { rows } = await admin.query<{ nombre: string }>(
        "SELECT nombre FROM taxonomy.brands WHERE nombre = 'Transaccion Rollback'",
      );
      expect(rows).toHaveLength(0);
    });

    it('verificarReadiness resuelve contra la base viva', async () => {
      await expect(repo.verificarReadiness()).resolves.toBeUndefined();
    });

    describe('readiness contra PostgreSQL real y permisos', () => {
      let appNest: INestApplication<App>;

      beforeAll(async () => {
        appNest = await levantarAppNest();
      }, 30_000);

      afterAll(async () => {
        await appNest?.close();
      }, 30_000);

      it('responde 200 cuando el rol puede leer las columnas requeridas', async () => {
        await request(appNest.getHttpServer())
          .get('/health/readiness')
          .expect(HttpStatus.OK);
      });

      it('responde 503 si se revoca SELECT sobre taxonomy.brands', async () => {
        await admin.query(`REVOKE SELECT ON taxonomy.brands FROM ${ROL_APP}`);
        try {
          await request(appNest.getHttpServer())
            .get('/health/readiness')
            .expect(HttpStatus.SERVICE_UNAVAILABLE);
        } finally {
          await admin.query(`GRANT SELECT ON taxonomy.brands TO ${ROL_APP}`);
        }
      });

      it('responde 503 si falta SELECT sobre categories.orden usado por la lectura comercial', async () => {
        await admin.query(
          `REVOKE SELECT ON taxonomy.categories FROM ${ROL_APP}`,
        );
        await admin.query(
          `GRANT SELECT (id, nombre, categoria_padre_id, nivel, estado) ON taxonomy.categories TO ${ROL_APP}`,
        );
        try {
          await request(appNest.getHttpServer())
            .get('/health/readiness')
            .expect(HttpStatus.SERVICE_UNAVAILABLE);
        } finally {
          await admin.query(
            `REVOKE SELECT (id, nombre, categoria_padre_id, nivel, estado) ON taxonomy.categories FROM ${ROL_APP}`,
          );
          await admin.query(
            `GRANT SELECT ON taxonomy.categories TO ${ROL_APP}`,
          );
        }
      });

      it('responde 503 si se revoca SELECT sobre la columna logo_url', async () => {
        await admin.query(`REVOKE SELECT ON taxonomy.brands FROM ${ROL_APP}`);
        await admin.query(
          `GRANT SELECT (id, nombre, descripcion, pais_origen_iso, estado) ON taxonomy.brands TO ${ROL_APP}`,
        );
        try {
          await request(appNest.getHttpServer())
            .get('/health/readiness')
            .expect(HttpStatus.SERVICE_UNAVAILABLE);
        } finally {
          await admin.query(
            `REVOKE SELECT (id, nombre, descripcion, pais_origen_iso, estado) ON taxonomy.brands FROM ${ROL_APP}`,
          );
          await admin.query(`GRANT SELECT ON taxonomy.brands TO ${ROL_APP}`);
        }
      });

      it('vuelve a responder 200 al restaurar los permisos', async () => {
        await request(appNest.getHttpServer())
          .get('/health/readiness')
          .expect(HttpStatus.OK);
      });
    });

    it('traduce la indisponibilidad de la base a 503', async () => {
      const repoCaido = crearRepositorioDrizzle(
        'postgresql://postgres:postgres@127.0.0.1:1/taxonomy',
      );

      try {
        const error = await repoCaido
          .findCategoriasActivas()
          .catch((e: unknown) => e);

        expect(error).toBeInstanceOf(ProblemDetailsException);
        expect((error as ProblemDetailsException).getStatus()).toBe(
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      } finally {
        await repoCaido.onApplicationShutdown();
      }
    });

    it('onApplicationShutdown cierra el pool y deja de atender consultas', async () => {
      const repoEfimero = crearRepositorioDrizzle(urlApp);

      await expect(repoEfimero.verificarReadiness()).resolves.toBeUndefined();
      await repoEfimero.onApplicationShutdown();

      await expect(repoEfimero.verificarReadiness()).rejects.toBeInstanceOf(
        ProblemDetailsException,
      );
    });

    it('el rol de aplicacion no puede crear objetos en el esquema', async () => {
      const error = await app
        .query('CREATE TABLE taxonomy.permiso_denegado (id int)')
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(Error);
      expect((error as { code?: string }).code).toBe('42501');
    });

    it('el rol de aplicacion no puede leer datos de otro schema', async () => {
      const error = await app
        .query('SELECT id FROM taxonomy_isolation_probe.private_data')
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(Error);
      expect((error as { code?: string }).code).toBe('42501');
    });

    it('la base aplica CHECK, UNIQUE y FK declaradas en el modelo Taxonomy', async () => {
      const checkError = await app
        .query(
          "INSERT INTO taxonomy.categories (nombre, nivel, orden) VALUES ('Nivel invalido', 3, 0)",
        )
        .catch((e: unknown) => e);
      expect((checkError as { code?: string }).code).toBe('23514');

      const foreignKeyError = await app
        .query(
          "INSERT INTO taxonomy.categories (nombre, categoria_padre_id, nivel, orden) VALUES ('Padre inexistente', '12345678-1234-1234-1234-123456789012', 2, 0)",
        )
        .catch((e: unknown) => e);
      expect((foreignKeyError as { code?: string }).code).toBe('23503');

      const uniqueError = await app
        .query("INSERT INTO taxonomy.brands (nombre) VALUES (' marathon ')")
        .catch((e: unknown) => e);
      expect((uniqueError as { code?: string }).code).toBe('23505');
    });

    it('persiste categorías solo con slug confirmado y serializa carreras de slug', async () => {
      const slug = `categoria-${randomUUID().replaceAll('-', '')}`;
      const creada = await writes.crearCategoria({
        nombre: 'Categoría de integración',
        slugConfirmado: slug,
      });
      expect(creada.slug).toBe(slug);
      expect(creada.estado).toBe('ACTIVO');
      expect(
        await dbApp
          .select({ slug: categorySeo.slug })
          .from(categorySeo)
          .where(eq(categorySeo.categoriaId, creada.categoriaId)),
      ).toEqual([{ slug }]);

      const carreraSlug = `carrera-${randomUUID().replaceAll('-', '')}`;
      const creaciones = await Promise.allSettled([
        writes.crearCategoria({
          nombre: 'Carrera A',
          slugConfirmado: carreraSlug,
        }),
        writes.crearCategoria({
          nombre: 'Carrera B',
          slugConfirmado: carreraSlug,
        }),
      ]);
      expect(
        creaciones.filter((resultado) => resultado.status === 'fulfilled'),
      ).toHaveLength(1);
      const rechazo = creaciones.find(
        (resultado) => resultado.status === 'rejected',
      );
      expect(rechazo?.status).toBe('rejected');
      if (rechazo?.status === 'rejected') {
        expect(codigoDe(rechazo.reason)).toBe('SLUG_DUPLICADO');
      }

      const duplicados = await dbApp
        .select({ slug: categorySeo.slug })
        .from(categorySeo)
        .where(eq(categorySeo.slug, carreraSlug));
      expect(duplicados).toHaveLength(1);
    });

    it('impide el tercer nivel y las reubicaciones que crean ciclos o exceden profundidad', async () => {
      const depthError = await writes
        .crearCategoria({
          nombre: 'Tercer nivel rechazado',
          categoriaPadreId: '22222222-2222-4222-8222-222222222222',
          slugConfirmado: `tercer-nivel-${randomUUID().replaceAll('-', '')}`,
        })
        .catch((error: unknown) => error);
      expect(codigoDe(depthError)).toBe('PROFUNDIDAD_CATEGORIA_EXCEDIDA');

      const root = await writes.crearCategoria({
        nombre: 'Raíz cíclica',
        slugConfirmado: `raiz-${randomUUID().replaceAll('-', '')}`,
      });
      const child = await writes.crearCategoria({
        nombre: 'Hija cíclica',
        categoriaPadreId: root.categoriaId,
        slugConfirmado: `hija-${randomUUID().replaceAll('-', '')}`,
      });
      const cycleError = await writes
        .reubicarCategoria(root.categoriaId, child.categoriaId, root.version)
        .catch((error: unknown) => error);
      expect(codigoDe(cycleError)).toBe('CATEGORIA_INVALIDA');
      const rootPersistida = await dbApp
        .select({ parent: categorias.categoriaPadreId })
        .from(categorias)
        .where(eq(categorias.id, root.categoriaId));
      expect(rootPersistida[0]?.parent).toBeNull();
    });

    it('mantiene unicidad normalizada de marca ante inactivas y carreras concurrentes', async () => {
      const nombreArchivado = `Archivada ${randomUUID()}`;
      const marca = await writes.crearMarca({ nombre: nombreArchivado });
      await admin.query(
        "UPDATE taxonomy.brands SET estado = 'INACTIVO' WHERE id = $1",
        [marca.marcaId],
      );
      const duplicada = await writes
        .crearMarca({
          nombre: `  ${nombreArchivado.toLocaleUpperCase('es')}  `,
        })
        .catch((error: unknown) => error);
      expect(codigoDe(duplicada)).toBe('MARCA_DUPLICADA');

      const nombreCarrera = `Concurrente ${randomUUID()}`;
      const creaciones = await Promise.allSettled([
        writes.crearMarca({ nombre: nombreCarrera }),
        writes.crearMarca({ nombre: nombreCarrera.toLocaleUpperCase('es') }),
      ]);
      expect(
        creaciones.filter((resultado) => resultado.status === 'fulfilled'),
      ).toHaveLength(1);
      const rechazo = creaciones.find(
        (resultado) => resultado.status === 'rejected',
      );
      expect(rechazo?.status).toBe('rejected');
      if (rechazo?.status === 'rejected') {
        expect(codigoDe(rechazo.reason)).toBe('MARCA_DUPLICADA');
      }
    });

    it('resuelve el servicio de escritura del módulo y devuelve Problem Details contractual', async () => {
      const moduleFixture = await Test.createTestingModule({
        imports: [TaxonomySvcModule.forRoot({ databaseUrl: urlApp })],
      }).compile();
      const appNest: INestApplication<App> =
        moduleFixture.createNestApplication();
      await appNest.init();
      const writeService = appNest.get(TaxonomyWriteService);
      const nombre = `Problem brand ${randomUUID()}`;

      try {
        await writeService.crearMarca({ nombre });
        const error = await writeService
          .crearMarca({ nombre: nombre.toLocaleUpperCase('es') })
          .catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(ProblemDetailsException);
        expect((error as ProblemDetailsException).problem).toMatchObject({
          status: HttpStatus.CONFLICT,
          code: 'MARCA_DUPLICADA',
        });
      } finally {
        await appNest.close();
      }
    });

    it('persiste bajas lógicas seguras, restaura en rechazo/timeout y reactiva hijo tras padre', async () => {
      const correlationId = randomUUID();
      const marca = await writes.crearMarca({
        nombre: `Baja segura ${randomUUID()}`,
      });
      const bajaMarca = await writes.solicitarBajaMarca(
        marca.marcaId,
        correlationId,
      );
      expect(bajaMarca.status).toBe('PENDING_DEACTIVATION');
      const comando = await dbApp
        .select({ event: outbox.eventName, kind: outbox.kind })
        .from(outbox)
        .where(eq(outbox.operationId, bajaMarca.operation_id));
      expect(comando).toEqual([
        {
          event: 'taxonomy.master.deactivation.check.requested',
          kind: 'command',
        },
      ]);
      await writes.procesarResultadoBajaMarca(
        bajaMarca.operation_id,
        'HAS_ACTIVE_PRODUCTS',
        correlationId,
      );
      const marcaTrasRechazo = await dbApp
        .select({ estado: marcas.estado })
        .from(marcas)
        .where(eq(marcas.id, marca.marcaId));
      expect(marcaTrasRechazo[0]?.estado).toBe('ACTIVO');

      const bajaFinal = await writes.solicitarBajaMarca(
        marca.marcaId,
        correlationId,
      );
      await writes.procesarResultadoBajaMarca(
        bajaFinal.operation_id,
        'CLEAR',
        correlationId,
      );
      const marcaBorradaLogicamente = await dbApp
        .select({ id: marcas.id, estado: marcas.estado })
        .from(marcas)
        .where(eq(marcas.id, marca.marcaId));
      expect(marcaBorradaLogicamente).toEqual([
        { id: marca.marcaId, estado: 'INACTIVO' },
      ]);
      expect(await writes.reactivarMarca(marca.marcaId)).toMatchObject({
        estado: 'ACTIVO',
      });

      const padre = await writes.crearCategoria({
        nombre: 'Padre reactivación',
        slugConfirmado: `padre-${randomUUID().replaceAll('-', '')}`,
      });
      const hija = await writes.crearCategoria({
        nombre: 'Hija reactivación',
        categoriaPadreId: padre.categoriaId,
        slugConfirmado: `hija-${randomUUID().replaceAll('-', '')}`,
      });
      const bajaPadreConHijaActiva = await writes
        .solicitarBajaCategoria(padre.categoriaId, correlationId)
        .catch((error: unknown) => error);
      expect(codigoDe(bajaPadreConHijaActiva)).toBe(
        'CATEGORIA_CON_SUBCATEGORIAS_ACTIVAS',
      );
      const bajaHija = await writes.solicitarBajaCategoria(
        hija.categoriaId,
        correlationId,
      );
      await writes.procesarResultadoBajaCategoria(
        bajaHija.operation_id,
        'CLEAR',
        correlationId,
      );
      const bajaPadre = await writes.solicitarBajaCategoria(
        padre.categoriaId,
        correlationId,
      );
      await writes.procesarResultadoBajaCategoria(
        bajaPadre.operation_id,
        'CLEAR',
        correlationId,
      );
      const hijoAntesDePadre = await writes
        .reactivarCategoria(hija.categoriaId)
        .catch((error: unknown) => error);
      expect(codigoDe(hijoAntesDePadre)).toBe('CATEGORIA_PADRE_INACTIVA');
      await writes.reactivarCategoria(padre.categoriaId);
      await expect(
        writes.reactivarCategoria(hija.categoriaId),
      ).resolves.toMatchObject({
        estado: 'ACTIVO',
      });
    });

    it('conecta tipo inmutable, valores LISTA y obligatoriedad a las tablas correctas', async () => {
      const numericError = await writes
        .crearCaracteristica({ nombre: 'Peso sin unidad', tipo: 'NUMERO' })
        .catch((error: unknown) => error);
      expect(codigoDe(numericError)).toBe('VALOR_NUMERICO_INVALIDO');

      const numerica = await writes.crearCaracteristica({
        nombre: `Peso ${randomUUID()}`,
        tipo: 'NUMERO',
        unidadMedida: 'kg',
      });
      const typeError = await writes
        .actualizarCaracteristica(numerica.id, { tipo: 'LISTA' })
        .catch((error: unknown) => error);
      expect(codigoDe(typeError)).toBe('TIPO_CARACTERISTICA_INMUTABLE');
      const persistedNumerica = await dbApp
        .select({ tipo: characteristics.tipo })
        .from(characteristics)
        .where(eq(characteristics.id, numerica.id));
      expect(persistedNumerica[0]?.tipo).toBe('NUMERO');

      const lista = await writes.crearCaracteristica({
        nombre: `Color ${randomUUID()}`,
        tipo: 'LISTA',
      });
      const value = await writes.crearValorPermitido(lista.id, 'Rojo');
      const duplicateValue = await writes
        .crearValorPermitido(lista.id, ' rojo ')
        .catch((error: unknown) => error);
      expect(codigoDe(duplicateValue)).toBe('VALIDACION');
      const valueTimeoutCorrelation = randomUUID();
      const valueDeactivate = await writes.solicitarBajaValorPermitido(
        lista.id,
        value.id,
        valueTimeoutCorrelation,
      );
      await writes.procesarResultadoBajaValorPermitido(
        valueDeactivate.operation_id,
        'TIMEOUT',
        valueTimeoutCorrelation,
      );
      const valueAfterTimeout = await dbApp
        .select({ estado: characteristicValues.estado })
        .from(characteristicValues)
        .where(eq(characteristicValues.id, value.id));
      expect(valueAfterTimeout[0]?.estado).toBe('ACTIVO');
      const valueCorrelationId = randomUUID();
      const valueDeactivateFinal = await writes.solicitarBajaValorPermitido(
        lista.id,
        value.id,
        valueCorrelationId,
      );
      await writes.procesarResultadoBajaValorPermitido(
        valueDeactivateFinal.operation_id,
        'CLEAR',
        valueCorrelationId,
      );
      const valueAfterLogicalDelete = await dbApp
        .select({
          id: characteristicValues.id,
          estado: characteristicValues.estado,
        })
        .from(characteristicValues)
        .where(eq(characteristicValues.id, value.id));
      expect(valueAfterLogicalDelete).toEqual([
        { id: value.id, estado: 'INACTIVO' },
      ]);
      await expect(
        writes.reactivarValorPermitido(lista.id, value.id),
      ).resolves.toMatchObject({ id: value.id, estado: 'ACTIVO' });

      const tipo = await writes.crearTipoProducto({
        nombre: `Tipo ${randomUUID()}`,
      });
      const asociacion = await writes.asociarCaracteristica({
        tipoProductoId: tipo.id,
        caracteristicaId: lista.id,
        obligatoria: true,
        schemaVersion: tipo.schemaVersion,
        correlationId: randomUUID(),
      });
      expect(asociacion.obligatoria).toBe(true);
      expect(asociacion.schemaVersion).toBe(tipo.schemaVersion + 1);
      const persistedAssociation = await dbApp
        .select({
          id: productTypeCharacteristics.id,
          obligatoria: productTypeCharacteristics.obligatoria,
        })
        .from(productTypeCharacteristics)
        .where(eq(productTypeCharacteristics.id, asociacion.id));
      expect(persistedAssociation).toEqual([
        { id: asociacion.id, obligatoria: true },
      ]);
      const actualizada = await writes.actualizarAsociacionCaracteristica(
        tipo.id,
        lista.id,
        false,
        asociacion.schemaVersion,
        randomUUID(),
      );
      expect(actualizada.obligatoria).toBe(false);
      expect(actualizada.schemaVersion).toBe(asociacion.schemaVersion + 1);
      const event = await dbApp
        .select({ name: outbox.eventName, payload: outbox.payload })
        .from(outbox)
        .where(eq(outbox.eventName, 'taxonomy.product-type-schema.changed'));
      expect(
        event.some(
          (message) => message.payload.data.change_type === 'ASSOCIATED',
        ),
      ).toBe(true);
      expect(
        event.some(
          (message) => message.payload.data.change_type === 'REQUIRED_CHANGED',
        ),
      ).toBe(true);
    });

    it('aplica el límite de 50 opciones LISTA contra filas PostgreSQL existentes', async () => {
      const lista = await writes.crearCaracteristica({
        nombre: `Talla ${randomUUID()}`,
        tipo: 'LISTA',
      });
      await dbApp.insert(characteristicValues).values(
        Array.from({ length: 50 }, (_, indice) => ({
          caracteristicaId: lista.id,
          nombre: `Opción ${indice + 1}`,
          estado: 'ACTIVO' as const,
        })),
      );

      const error = await writes
        .crearValorPermitido(lista.id, 'Opción adicional')
        .catch((caught: unknown) => caught);
      expect(codigoDe(error)).toBe('VALOR_LISTA_LIMITE_EXCEDIDO');
      const activos = await dbApp
        .select({ id: characteristicValues.id })
        .from(characteristicValues)
        .where(
          and(
            eq(characteristicValues.caracteristicaId, lista.id),
            eq(characteristicValues.estado, 'ACTIVO'),
          ),
        );
      expect(activos).toHaveLength(50);
    });

    it('serializa 20 asociaciones y persiste required solo en la asociación', async () => {
      const tipo = await writes.crearTipoProducto({
        nombre: `Deportivo ${randomUUID()}`,
      });
      const caracteristicas = await dbApp
        .insert(characteristics)
        .values(
          Array.from({ length: 21 }, (_, indice) => ({
            nombre: `Campo ${indice}-${randomUUID()}`,
            tipo: 'TEXTO' as const,
            unidadMedida: null,
            estado: 'ACTIVO' as const,
          })),
        )
        .returning({ id: characteristics.id });
      const operaciones = await Promise.allSettled(
        caracteristicas.map((caracteristica, indice) =>
          writes.asociarCaracteristica({
            tipoProductoId: tipo.id,
            caracteristicaId: caracteristica.id,
            obligatoria: indice % 2 === 0,
          }),
        ),
      );
      expect(
        operaciones.filter((resultado) => resultado.status === 'fulfilled'),
      ).toHaveLength(20);
      const fallidas = operaciones.filter(
        (resultado) => resultado.status === 'rejected',
      );
      expect(fallidas).toHaveLength(1);
      if (fallidas[0]?.status === 'rejected') {
        expect(codigoDe(fallidas[0].reason)).toBe(
          'LIMITE_CARACTERISTICAS_EXCEDIDO',
        );
      }

      const persistidas = await dbApp
        .select({ id: productTypeCharacteristics.id })
        .from(productTypeCharacteristics)
        .where(eq(productTypeCharacteristics.tipoProductoId, tipo.id));
      const tipoPersistido = await dbApp
        .select({ version: productTypes.schemaVersion })
        .from(productTypes)
        .where(eq(productTypes.id, tipo.id));
      expect(persistidas).toHaveLength(20);
      expect(tipoPersistido[0]?.version).toBe(21);
      const columnasCaracteristica = await admin.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'taxonomy' AND table_name = 'characteristics'`,
      );
      expect(
        columnasCaracteristica.rows.map((fila) => fila.column_name),
      ).not.toContain('obligatoria');
    });

    it('GET /api/v1/categorias sirve datos reales a traves del modulo', async () => {
      const moduleFixture = await Test.createTestingModule({
        imports: [TaxonomySvcModule.forRoot({ databaseUrl: urlApp })],
      }).compile();
      const appNest: INestApplication<App> =
        moduleFixture.createNestApplication();
      await appNest.init();

      try {
        const categorias = await request(appNest.getHttpServer())
          .get('/api/v1/categorias')
          .expect(200);

        const nombres = categorias.body.categories.map(
          (c: { name: string }) => c.name,
        );
        expect(nombres).toEqual(
          expect.arrayContaining(['Calzado', 'Zapatillas']),
        );

        await request(appNest.getHttpServer())
          .get('/health/readiness')
          .expect(200);
      } finally {
        await appNest.close();
      }
    });

    describe('repositorio de runtime (PostgresTaxonomyRepository)', () => {
      let poolRuntime: Pool;
      let repoRuntime: PostgresTaxonomyRepository;

      beforeAll(() => {
        poolRuntime = new Pool({ connectionString: urlApp });
        repoRuntime = new PostgresTaxonomyRepository(
          adaptadorRuntime(poolRuntime),
        );
      });

      afterAll(async () => {
        try {
          await poolRuntime?.end();
        } catch {
          /* cierre defensivo */
        }
      });

      it('ejecuta consultas reales y devuelve solo filas ACTIVO', async () => {
        const categorias = await repoRuntime.findCategoriasActivas();
        expect(categorias.map((c) => c.nombre)).toEqual(
          expect.arrayContaining(['Calzado', 'Zapatillas']),
        );
        expect(categorias.every((c) => c.estado === 'ACTIVO')).toBe(true);

        const marcasActivas = await repoRuntime.findMarcasActivas();
        const nombresMarcas = marcasActivas.map((m) => m.nombre);
        expect(nombresMarcas).toContain('Marathon');
        expect(nombresMarcas).not.toContain('Retirada');
        expect(marcasActivas.every((m) => m.estado === 'ACTIVO')).toBe(true);
      });

      it('readiness es verdadero contra la base viva', async () => {
        await expect(repoRuntime.readiness()).resolves.toBe(true);
        await expect(repoRuntime.verificarReadiness()).resolves.toBeUndefined();
      });

      it('traduce permisos denegados a 503 vía HTTP y se recupera', async () => {
        const moduleFixture = await Test.createTestingModule({
          imports: [TaxonomySvcModule],
        })
          .overrideProvider(TAXONOMY_REPOSITORY)
          .useValue(repoRuntime)
          .compile();
        const appRuntime: INestApplication<App> =
          moduleFixture.createNestApplication();
        await appRuntime.init();

        try {
          await request(appRuntime.getHttpServer())
            .get('/health/readiness')
            .expect(HttpStatus.OK);

          await admin.query(`REVOKE SELECT ON taxonomy.brands FROM ${ROL_APP}`);
          try {
            await request(appRuntime.getHttpServer())
              .get('/health/readiness')
              .expect(HttpStatus.SERVICE_UNAVAILABLE);
          } finally {
            await admin.query(`GRANT SELECT ON taxonomy.brands TO ${ROL_APP}`);
          }

          await request(appRuntime.getHttpServer())
            .get('/health/readiness')
            .expect(HttpStatus.OK);
        } finally {
          await appRuntime.close();
        }
      });

      it('responde 503 cuando falta SELECT en categories.orden y falla la lectura comercial que ordena por esa columna', async () => {
        const moduleFixture = await Test.createTestingModule({
          imports: [TaxonomySvcModule],
        })
          .overrideProvider(TAXONOMY_REPOSITORY)
          .useValue(repoRuntime)
          .compile();
        const appRuntime: INestApplication<App> =
          moduleFixture.createNestApplication();
        await appRuntime.init();

        await admin.query(
          `REVOKE SELECT ON taxonomy.categories FROM ${ROL_APP}`,
        );
        await admin.query(
          `GRANT SELECT (id, nombre, categoria_padre_id, estado) ON taxonomy.categories TO ${ROL_APP}`,
        );
        try {
          await expect(repoRuntime.findCategoriasActivas()).rejects.toThrow();
          await request(appRuntime.getHttpServer())
            .get('/health/readiness')
            .expect(HttpStatus.SERVICE_UNAVAILABLE);
        } finally {
          await admin.query(
            `REVOKE SELECT (id, nombre, categoria_padre_id, estado) ON taxonomy.categories FROM ${ROL_APP}`,
          );
          await admin.query(
            `GRANT SELECT ON taxonomy.categories TO ${ROL_APP}`,
          );
          await appRuntime.close();
        }
      });
    });
  },
);
