import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { Inject, Injectable } from '@nestjs/common';
import { Database } from '../database.js';
import type { TransaccionTaxonomy } from './drizzle-taxonomy.repository.js';
import type { TaxonomyWriteUnitOfWork } from './taxonomy-write.unit-of-work.js';
import {
  TaxonomyInvariantError,
  crearAsociacionTipoCaracteristica,
  mapearConflictoUnicoTaxonomy,
  proponerSlugCategoria,
  eliminarLogicamente,
  validarActualizacionCaracteristica,
  validarBajaCategoria,
  validarDefinicionCaracteristica,
  validarJerarquiaCategoria,
  validarNuevaAsociacionTipoCaracteristica,
  validarReactivacionCategoria,
  validarResultadoBajaSegura,
  validarSlugConfirmado,
  validarUnicidadNombreMarca,
  validarValorCaracteristica,
} from '../domain/taxonomy-invariants.js';
import type {
  AsociacionTipoCaracteristica,
  CategoriaMaestra,
  CaracteristicaMaestra,
  EstadoMaestro,
  TipoCaracteristica,
  TipoProductoMaestro,
  ValorPermitido,
} from '../domain/taxonomy-invariants.js';
import {
  categorySeo,
  categorias,
  characteristicValues,
  characteristics,
  marcas,
  masterDeactivationOperations,
  outbox,
  productTypeCharacteristics,
  productTypes,
} from './taxonomy.schema.js';

const TIPO_BAJA_CATEGORIA = 'CATEGORY';
const TIPO_BAJA_MARCA = 'BRAND';
const TIPO_BAJA_VALOR_CARACTERISTICA = 'CHARACTERISTIC_VALUE';
const CODIGO_BLOQUEO_ARBOL = 'taxonomy.category.hierarchy';
type TipoEntidadBaja =
  | typeof TIPO_BAJA_CATEGORIA
  | typeof TIPO_BAJA_MARCA
  | typeof TIPO_BAJA_VALOR_CARACTERISTICA;

export interface CrearCategoria {
  nombre: string;
  slugConfirmado: string;
  descripcion?: string | null;
  categoriaPadreId?: string | null;
  orden?: number;
  imagenUrl?: string | null;
}

export interface CategoriaEscritura {
  categoriaId: string;
  nombre: string;
  descripcion: string | null;
  categoriaPadreId: string | null;
  orden: number;
  imagenUrl: string | null;
  estado: EstadoMaestro;
  version: number;
  slug: string;
}

export interface CrearMarca {
  nombre: string;
  descripcion?: string | null;
  logoUrl?: string | null;
  paisOrigenIso?: string | null;
}

export interface MarcaEscritura {
  marcaId: string;
  nombre: string;
  descripcion: string | null;
  logoUrl: string | null;
  paisOrigenIso: string | null;
  estado: EstadoMaestro;
  version: number;
}

export interface CrearCaracteristica {
  nombre: string;
  tipo: TipoCaracteristica;
  unidadMedida?: string | null;
}

export interface CrearTipoProducto {
  nombre: string;
}

export interface AsociarCaracteristica {
  tipoProductoId: string;
  caracteristicaId: string;
  obligatoria: boolean;
  schemaVersion?: number;
  correlationId?: string;
}

export interface OperacionBajaAceptada {
  operation_id: string;
  entity_type: TipoEntidadBaja;
  entity_id: string;
  version: number;
  status: 'PENDING_DEACTIVATION';
}

type CategoriaDb = Pick<CategoriaMaestra, 'id' | 'categoriaPadreId' | 'estado'>;

function aCategoriaEscritura(
  fila: typeof categorias.$inferSelect,
  slug: string,
): CategoriaEscritura {
  return {
    categoriaId: fila.id,
    nombre: fila.nombre,
    descripcion: fila.descripcion ?? null,
    categoriaPadreId: fila.categoriaPadreId ?? null,
    orden: fila.orden,
    imagenUrl: fila.imagenUrl ?? null,
    estado: fila.estado,
    version: fila.taxonomyVersion,
    slug,
  };
}

function crearError(code: string, detail: string): TaxonomyInvariantError {
  return new TaxonomyInvariantError(code, detail);
}

function mapearErrorPersistencia(error: unknown): never {
  const conflicto = mapearConflictoUnicoTaxonomy(error);
  if (conflicto) throw conflicto;
  throw error;
}

async function bloquearArbol(tx: TransaccionTaxonomy): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${CODIGO_BLOQUEO_ARBOL}), 0)`,
  );
}

async function persistirSolicitudBaja(
  tx: TransaccionTaxonomy,
  entityType: TipoEntidadBaja,
  entityId: string,
  version: number,
  correlationId: string,
  reason?: string | null,
): Promise<OperacionBajaAceptada> {
  const operationId = randomUUID();
  await tx.insert(masterDeactivationOperations).values({
    operationId,
    entityType,
    entityId,
    status: 'REQUESTED',
    reason: reason ?? null,
    correlationId,
  });
  const eventName = 'taxonomy.master.deactivation.check.requested';
  const data = {
    operation_id: operationId,
    entity_type: entityType,
    entity_id: entityId,
    version,
  };
  const envelope = newEnvelope(
    eventName,
    'command',
    correlationId,
    operationId,
    data,
  );
  await tx.insert(outbox).values({
    messageId: envelope.messageId,
    eventName,
    kind: 'command',
    correlationId,
    operationId,
    occurredAt: new Date(),
    payload: envelope.payload,
  });
  return {
    operation_id: operationId,
    entity_type: entityType,
    entity_id: entityId,
    version,
    status: 'PENDING_DEACTIVATION',
  };
}

async function persistirResultadoBaja(
  tx: TransaccionTaxonomy,
  entityType: TipoEntidadBaja,
  entityId: string,
  operationId: string,
  version: number,
  estado: EstadoMaestro,
  resultado: 'CLEAR' | 'HAS_ACTIVE_PRODUCTS' | 'TIMEOUT' | 'ERROR',
  correlationId: string,
): Promise<void> {
  const eventName =
    estado === 'INACTIVO'
      ? 'taxonomy.master.deactivated'
      : 'taxonomy.master.deactivation.rejected';
  const kind = estado === 'INACTIVO' ? 'event' : 'result';
  const envelope = newEnvelope(eventName, kind, correlationId, operationId, {
    operation_id: operationId,
    entity_type: entityType,
    entity_id: entityId,
    version,
    result: resultado,
  });
  await tx.insert(outbox).values({
    messageId: envelope.messageId,
    eventName,
    kind,
    correlationId,
    operationId,
    occurredAt: new Date(),
    payload: envelope.payload,
  });
}

async function persistirCambioEsquemaTipoProducto(
  tx: TransaccionTaxonomy,
  input: {
    tipoProductoId: string;
    schemaVersion: number;
    changeType: 'ASSOCIATED' | 'REQUIRED_CHANGED';
    caracteristicaId: string;
    correlationId: string;
  },
): Promise<void> {
  const eventName = 'taxonomy.product-type-schema.changed';
  const operationId = randomUUID();
  const envelope = newEnvelope(
    eventName,
    'event',
    input.correlationId,
    operationId,
    {
      tipo_producto_id: input.tipoProductoId,
      schema_version: input.schemaVersion,
      change_type: input.changeType,
      caracteristica_id: input.caracteristicaId,
      updated_at: new Date().toISOString(),
    },
  );
  await tx.insert(outbox).values({
    messageId: envelope.messageId,
    eventName,
    kind: 'event',
    correlationId: input.correlationId,
    operationId,
    occurredAt: new Date(),
    payload: envelope.payload,
  });
}

async function leerCategorias(tx: TransaccionTaxonomy): Promise<CategoriaDb[]> {
  return tx
    .select({
      id: categorias.id,
      categoriaPadreId: categorias.categoriaPadreId,
      estado: categorias.estado,
    })
    .from(categorias);
}

function newEnvelope(
  name: string,
  kind: 'command' | 'event' | 'result',
  correlationId: string,
  operationId: string,
  data: Record<string, unknown>,
): { messageId: string; payload: Record<string, unknown> } {
  const messageId = randomUUID();
  return {
    messageId,
    payload: {
      message_id: messageId,
      schema_version: 1,
      occurred_at: new Date().toISOString(),
      correlation_id: correlationId,
      causation_id: null,
      operation_id: operationId,
      producer: 'taxonomy-svc',
      kind,
      name,
      data,
    },
  };
}

@Injectable()
export class TaxonomyWriteRepository {
  constructor(
    @Inject(Database)
    private readonly unitOfWork: TaxonomyWriteUnitOfWork,
  ) {}

  async proponerSlug(nombre: string): Promise<{
    slug: string;
    colisionResuelta: boolean;
  }> {
    return this.unitOfWork.enTransaccion(async (tx) => {
      const slugs = await tx
        .select({ slug: categorySeo.slug })
        .from(categorySeo);
      return proponerSlugCategoria(
        nombre,
        new Set(slugs.map((fila) => fila.slug)),
      );
    });
  }

  async crearCategoria(input: CrearCategoria): Promise<CategoriaEscritura> {
    try {
      return await this.unitOfWork.enTransaccion(async (tx) => {
        validarTextoRequerido(input.nombre, 'El nombre de la categoría');
        validarOrden(input.orden);
        await bloquearArbol(tx);
        const grafo = await leerCategorias(tx);
        const parentId = input.categoriaPadreId ?? null;
        const id = randomUUID();
        validarJerarquiaCategoria(id, parentId, grafo, 2);

        const slugs = await tx
          .select({ slug: categorySeo.slug })
          .from(categorySeo);
        validarSlugConfirmado(
          input.slugConfirmado,
          new Set(slugs.map((fila) => fila.slug)),
        );

        const filaPadre = parentId
          ? grafo.find((categoria) => categoria.id === parentId)
          : undefined;
        const nivel = parentId ? (filaPadre ? 2 : 1) : 1;
        const [fila] = await tx
          .insert(categorias)
          .values({
            id,
            nombre: input.nombre.trim(),
            descripcion: input.descripcion ?? null,
            categoriaPadreId: parentId,
            nivel,
            orden: input.orden ?? 0,
            imagenUrl: input.imagenUrl ?? null,
            estado: 'ACTIVO',
          })
          .returning();
        await tx.insert(categorySeo).values({
          id: randomUUID(),
          categoriaId: id,
          slug: input.slugConfirmado,
        });
        return aCategoriaEscritura(fila, input.slugConfirmado);
      });
    } catch (error) {
      mapearErrorPersistencia(error);
    }
  }

  async reubicarCategoria(
    categoriaId: string,
    categoriaPadreId: string | null,
    expectedVersion?: number,
  ): Promise<CategoriaEscritura> {
    return bloquearArbolFueraDeTransaccion(this.unitOfWork, async (tx) => {
      const grafo = await leerCategorias(tx);
      const actual = grafo.find((categoria) => categoria.id === categoriaId);
      if (!actual) {
        throw crearError('CATEGORIA_NO_ENCONTRADA', 'La categoría no existe.');
      }
      const [filaActual] = await tx
        .select()
        .from(categorias)
        .where(eq(categorias.id, categoriaId))
        .for('update');
      validarVersion(filaActual.taxonomyVersion, expectedVersion);
      validarJerarquiaCategoria(categoriaId, categoriaPadreId, grafo, 2);
      const [padre] = categoriaPadreId
        ? grafo.filter((categoria) => categoria.id === categoriaPadreId)
        : [];
      const [actualizada] = await tx
        .update(categorias)
        .set({
          categoriaPadreId,
          nivel: categoriaPadreId ? (padre ? 2 : 1) : 1,
          taxonomyVersion: filaActual.taxonomyVersion + 1,
          updatedAt: new Date(),
        })
        .where(eq(categorias.id, categoriaId))
        .returning();
      const [seo] = await tx
        .select({ slug: categorySeo.slug })
        .from(categorySeo)
        .where(eq(categorySeo.categoriaId, categoriaId));
      return aCategoriaEscritura(actualizada, seo?.slug ?? '');
    });
  }

  async reactivarCategoria(
    categoriaId: string,
    expectedVersion?: number,
  ): Promise<CategoriaEscritura> {
    return bloquearArbolFueraDeTransaccion(this.unitOfWork, async (tx) => {
      const grafo = await leerCategorias(tx);
      const actual = grafo.find((categoria) => categoria.id === categoriaId);
      if (!actual) {
        throw crearError('CATEGORIA_NO_ENCONTRADA', 'La categoría no existe.');
      }
      const [filaActual] = await tx
        .select()
        .from(categorias)
        .where(eq(categorias.id, categoriaId))
        .for('update');
      validarVersion(filaActual.taxonomyVersion, expectedVersion);
      validarReactivacionCategoria(categoriaId, grafo, 2);
      const [reactivada] = await tx
        .update(categorias)
        .set({
          estado: 'ACTIVO',
          taxonomyVersion: filaActual.taxonomyVersion + 1,
          updatedAt: new Date(),
        })
        .where(eq(categorias.id, categoriaId))
        .returning();
      const [seo] = await tx
        .select({ slug: categorySeo.slug })
        .from(categorySeo)
        .where(eq(categorySeo.categoriaId, categoriaId));
      return aCategoriaEscritura(reactivada, seo?.slug ?? '');
    });
  }

  async solicitarBajaCategoria(
    categoriaId: string,
    correlationId: string,
    reason?: string | null,
  ): Promise<OperacionBajaAceptada> {
    return bloquearArbolFueraDeTransaccion(this.unitOfWork, async (tx) => {
      const grafo = await leerCategorias(tx);
      validarBajaCategoria(categoriaId, grafo);
      const [fila] = await tx
        .select()
        .from(categorias)
        .where(eq(categorias.id, categoriaId))
        .for('update');
      const version = fila.taxonomyVersion + 1;
      await tx
        .update(categorias)
        .set({
          estado: 'PENDING_DEACTIVATION',
          taxonomyVersion: version,
          updatedAt: new Date(),
        })
        .where(eq(categorias.id, categoriaId));
      return persistirSolicitudBaja(
        tx,
        TIPO_BAJA_CATEGORIA,
        categoriaId,
        version,
        correlationId,
        reason,
      );
    });
  }

  async procesarResultadoBajaCategoria(
    operationId: string,
    resultado: 'CLEAR' | 'HAS_ACTIVE_PRODUCTS' | 'TIMEOUT' | 'ERROR',
    correlationId: string,
  ): Promise<EstadoMaestro> {
    return this.unitOfWork.enTransaccion(async (tx) => {
      const [operacion] = await tx
        .select()
        .from(masterDeactivationOperations)
        .where(eq(masterDeactivationOperations.operationId, operationId))
        .for('update');
      if (!operacion || operacion.entityType !== TIPO_BAJA_CATEGORIA) {
        throw crearError(
          'OPERACION_MAESTRA_NO_ENCONTRADA',
          'La operación de baja no existe.',
        );
      }
      validarCorrelacionOperacion(operacion.correlationId, correlationId);
      const [categoria] = await tx
        .select()
        .from(categorias)
        .where(eq(categorias.id, operacion.entityId))
        .for('update');
      if (!categoria) {
        throw crearError('CATEGORIA_NO_ENCONTRADA', 'La categoría no existe.');
      }
      const estado = validarResultadoBajaSegura(categoria.estado, resultado);
      const operationStatus =
        estado === 'INACTIVO'
          ? 'COMPLETED'
          : resultado === 'TIMEOUT' || resultado === 'ERROR'
            ? 'FAILED'
            : 'REJECTED';
      await tx
        .update(categorias)
        .set({
          estado,
          taxonomyVersion: categoria.taxonomyVersion + 1,
          updatedAt: new Date(),
        })
        .where(eq(categorias.id, categoria.id));
      await tx
        .update(masterDeactivationOperations)
        .set({ status: operationStatus, updatedAt: new Date() })
        .where(eq(masterDeactivationOperations.operationId, operationId));

      const eventName =
        estado === 'INACTIVO'
          ? 'taxonomy.master.deactivated'
          : 'taxonomy.master.deactivation.rejected';
      const kind = estado === 'INACTIVO' ? 'event' : 'result';
      const envelope = newEnvelope(
        eventName,
        kind,
        correlationId,
        operationId,
        {
          operation_id: operationId,
          entity_type: TIPO_BAJA_CATEGORIA,
          entity_id: categoria.id,
          version: categoria.taxonomyVersion + 1,
          result: resultado,
        },
      );
      await tx.insert(outbox).values({
        messageId: envelope.messageId,
        eventName,
        kind,
        correlationId,
        operationId,
        occurredAt: new Date(),
        payload: envelope.payload,
      });
      return estado;
    });
  }

  async crearMarca(input: CrearMarca): Promise<MarcaEscritura> {
    try {
      return await this.unitOfWork.enTransaccion(async (tx) => {
        validarPaisOrigen(input.paisOrigenIso ?? null);
        const existentes = await tx
          .select({
            id: marcas.id,
            nombre: marcas.nombre,
            estado: marcas.estado,
          })
          .from(marcas);
        validarUnicidadNombreMarca(input.nombre, existentes);
        const [fila] = await tx
          .insert(marcas)
          .values({
            nombre: input.nombre.trim(),
            descripcion: input.descripcion ?? null,
            logoUrl: input.logoUrl ?? null,
            paisOrigenIso: input.paisOrigenIso ?? null,
            estado: 'ACTIVO',
          })
          .returning();
        return {
          marcaId: fila.id,
          nombre: fila.nombre,
          descripcion: fila.descripcion ?? null,
          logoUrl: fila.logoUrl ?? null,
          paisOrigenIso: fila.paisOrigenIso ?? null,
          estado: fila.estado,
          version: fila.taxonomyVersion,
        };
      });
    } catch (error) {
      mapearErrorPersistencia(error);
    }
  }

  async actualizarMarca(
    marcaId: string,
    input: Partial<CrearMarca> & { version?: number },
  ): Promise<MarcaEscritura> {
    try {
      return await this.unitOfWork.enTransaccion(async (tx) => {
        const [actual] = await tx
          .select()
          .from(marcas)
          .where(eq(marcas.id, marcaId))
          .for('update');
        if (!actual) {
          throw crearError('MARCA_NO_ENCONTRADA', 'La marca no existe.');
        }
        validarVersion(actual.taxonomyVersion, input.version);
        const nombre = input.nombre?.trim() ?? actual.nombre;
        const existentes = await tx
          .select({
            id: marcas.id,
            nombre: marcas.nombre,
            estado: marcas.estado,
          })
          .from(marcas);
        validarUnicidadNombreMarca(nombre, existentes, marcaId);
        validarPaisOrigen(input.paisOrigenIso ?? actual.paisOrigenIso);
        const [fila] = await tx
          .update(marcas)
          .set({
            nombre,
            descripcion:
              input.descripcion === undefined
                ? actual.descripcion
                : input.descripcion,
            logoUrl:
              input.logoUrl === undefined ? actual.logoUrl : input.logoUrl,
            paisOrigenIso:
              input.paisOrigenIso === undefined
                ? actual.paisOrigenIso
                : input.paisOrigenIso,
            taxonomyVersion: actual.taxonomyVersion + 1,
            updatedAt: new Date(),
          })
          .where(eq(marcas.id, marcaId))
          .returning();
        return {
          marcaId: fila.id,
          nombre: fila.nombre,
          descripcion: fila.descripcion ?? null,
          logoUrl: fila.logoUrl ?? null,
          paisOrigenIso: fila.paisOrigenIso ?? null,
          estado: fila.estado,
          version: fila.taxonomyVersion,
        };
      });
    } catch (error) {
      mapearErrorPersistencia(error);
    }
  }

  async solicitarBajaMarca(
    marcaId: string,
    correlationId: string,
    reason?: string | null,
  ): Promise<OperacionBajaAceptada> {
    return this.unitOfWork.enTransaccion(async (tx) => {
      const [marca] = await tx
        .select()
        .from(marcas)
        .where(eq(marcas.id, marcaId))
        .for('update');
      if (!marca) {
        throw crearError('MARCA_NO_ENCONTRADA', 'La marca no existe.');
      }
      if (marca.estado !== 'ACTIVO') {
        throw crearError('VERSION_CONFLICT', 'La marca no está activa.');
      }
      const version = marca.taxonomyVersion + 1;
      await tx
        .update(marcas)
        .set({
          estado: 'PENDING_DEACTIVATION',
          taxonomyVersion: version,
          updatedAt: new Date(),
        })
        .where(eq(marcas.id, marcaId));
      return persistirSolicitudBaja(
        tx,
        TIPO_BAJA_MARCA,
        marcaId,
        version,
        correlationId,
        reason,
      );
    });
  }

  async reactivarMarca(
    marcaId: string,
    expectedVersion?: number,
  ): Promise<MarcaEscritura> {
    try {
      return await this.unitOfWork.enTransaccion(async (tx) => {
        const [actual] = await tx
          .select()
          .from(marcas)
          .where(eq(marcas.id, marcaId))
          .for('update');
        if (!actual) {
          throw crearError('MARCA_NO_ENCONTRADA', 'La marca no existe.');
        }
        validarVersion(actual.taxonomyVersion, expectedVersion);
        if (actual.estado !== 'INACTIVO') {
          throw crearError('VERSION_CONFLICT', 'La marca no está inactiva.');
        }
        const existentes = await tx
          .select({
            id: marcas.id,
            nombre: marcas.nombre,
            estado: marcas.estado,
          })
          .from(marcas);
        validarUnicidadNombreMarca(actual.nombre, existentes, marcaId);
        const [fila] = await tx
          .update(marcas)
          .set({
            estado: 'ACTIVO',
            taxonomyVersion: actual.taxonomyVersion + 1,
            updatedAt: new Date(),
          })
          .where(eq(marcas.id, marcaId))
          .returning();
        return {
          marcaId: fila.id,
          nombre: fila.nombre,
          descripcion: fila.descripcion ?? null,
          logoUrl: fila.logoUrl ?? null,
          paisOrigenIso: fila.paisOrigenIso ?? null,
          estado: fila.estado,
          version: fila.taxonomyVersion,
        };
      });
    } catch (error) {
      mapearErrorPersistencia(error);
    }
  }

  async cambiarEstadoCaracteristica(
    caracteristicaId: string,
    accion: 'desactivar' | 'reactivar',
    expectedVersion?: number,
  ) {
    return this.unitOfWork.enTransaccion(async (tx) => {
      const [actual] = await tx
        .select()
        .from(characteristics)
        .where(eq(characteristics.id, caracteristicaId))
        .for('update');
      if (!actual) {
        throw crearError(
          'CARACTERISTICA_NO_ENCONTRADA',
          'La característica no existe.',
        );
      }
      validarVersion(actual.taxonomyVersion, expectedVersion);
      const estado =
        accion === 'desactivar'
          ? eliminarLogicamente(actual.estado)
          : reactivarEstadoLogico(actual.estado);
      const [fila] = await tx
        .update(characteristics)
        .set({
          estado,
          taxonomyVersion: actual.taxonomyVersion + 1,
          updatedAt: new Date(),
        })
        .where(eq(characteristics.id, caracteristicaId))
        .returning();
      return fila;
    });
  }

  async procesarResultadoBajaMarca(
    operationId: string,
    resultado: 'CLEAR' | 'HAS_ACTIVE_PRODUCTS' | 'TIMEOUT' | 'ERROR',
    correlationId: string,
  ): Promise<EstadoMaestro> {
    return this.unitOfWork.enTransaccion(async (tx) => {
      const [operacion] = await tx
        .select()
        .from(masterDeactivationOperations)
        .where(eq(masterDeactivationOperations.operationId, operationId))
        .for('update');
      if (!operacion || operacion.entityType !== TIPO_BAJA_MARCA) {
        throw crearError(
          'OPERACION_MAESTRA_NO_ENCONTRADA',
          'La operación de baja no existe.',
        );
      }
      validarCorrelacionOperacion(operacion.correlationId, correlationId);
      const [marca] = await tx
        .select()
        .from(marcas)
        .where(eq(marcas.id, operacion.entityId))
        .for('update');
      if (!marca) {
        throw crearError('MARCA_NO_ENCONTRADA', 'La marca no existe.');
      }
      const estado = validarResultadoBajaSegura(marca.estado, resultado);
      const operationStatus =
        estado === 'INACTIVO'
          ? 'COMPLETED'
          : resultado === 'TIMEOUT' || resultado === 'ERROR'
            ? 'FAILED'
            : 'REJECTED';
      await tx
        .update(marcas)
        .set({
          estado,
          taxonomyVersion: marca.taxonomyVersion + 1,
          updatedAt: new Date(),
        })
        .where(eq(marcas.id, marca.id));
      await tx
        .update(masterDeactivationOperations)
        .set({ status: operationStatus, updatedAt: new Date() })
        .where(eq(masterDeactivationOperations.operationId, operationId));
      await persistirResultadoBaja(
        tx,
        operacion.entityType,
        marca.id,
        operationId,
        marca.taxonomyVersion + 1,
        estado,
        resultado,
        correlationId,
      );
      return estado;
    });
  }

  async crearCaracteristica(input: CrearCaracteristica) {
    validarTextoRequerido(input.nombre, 'El nombre de la característica');
    validarDefinicionCaracteristica(input.tipo, input.unidadMedida ?? null);
    return this.unitOfWork.enTransaccion(async (tx) => {
      const [fila] = await tx
        .insert(characteristics)
        .values({
          nombre: input.nombre.trim(),
          tipo: input.tipo,
          unidadMedida: input.unidadMedida ?? null,
          estado: 'ACTIVO',
        })
        .returning();
      return fila;
    });
  }

  async actualizarCaracteristica(
    caracteristicaId: string,
    input: {
      nombre?: string;
      tipo?: TipoCaracteristica;
      unidadMedida?: string | null;
      version?: number;
    },
  ) {
    return this.unitOfWork.enTransaccion(async (tx) => {
      const [actual] = await tx
        .select()
        .from(characteristics)
        .where(eq(characteristics.id, caracteristicaId))
        .for('update');
      if (!actual) {
        throw crearError(
          'CARACTERISTICA_NO_ENCONTRADA',
          'La característica no existe.',
        );
      }
      validarVersion(actual.taxonomyVersion, input.version);
      validarActualizacionCaracteristica(
        actual,
        input.tipo,
        input.unidadMedida,
      );
      const [fila] = await tx
        .update(characteristics)
        .set({
          nombre: input.nombre?.trim() ?? actual.nombre,
          unidadMedida:
            input.unidadMedida === undefined
              ? actual.unidadMedida
              : input.unidadMedida,
          taxonomyVersion: actual.taxonomyVersion + 1,
          updatedAt: new Date(),
        })
        .where(eq(characteristics.id, caracteristicaId))
        .returning();
      return fila;
    });
  }

  async crearValorPermitido(caracteristicaId: string, nombre: string) {
    return this.unitOfWork.enTransaccion(async (tx) => {
      const [caracteristica] = await tx
        .select()
        .from(characteristics)
        .where(eq(characteristics.id, caracteristicaId))
        .for('update');
      if (!caracteristica) {
        throw crearError(
          'CARACTERISTICA_NO_ENCONTRADA',
          'La característica no existe.',
        );
      }
      if (caracteristica.estado !== 'ACTIVO') {
        throw crearError('VALIDACION', 'La característica debe estar activa.');
      }
      const rows = await tx
        .select()
        .from(characteristicValues)
        .where(eq(characteristicValues.caracteristicaId, caracteristicaId));
      const valores: ValorPermitido[] = rows.map((row) => ({
        id: row.id,
        caracteristicaId: row.caracteristicaId,
        nombre: row.nombre,
        estado: row.estado,
      }));
      validarValorCaracteristica(caracteristica, nombre, valores);
      const [fila] = await tx
        .insert(characteristicValues)
        .values({
          caracteristicaId,
          nombre: nombre.trim(),
          estado: 'ACTIVO',
        })
        .returning();
      return fila;
    });
  }

  async solicitarBajaValorPermitido(
    caracteristicaId: string,
    valorId: string,
    correlationId: string,
    reason?: string | null,
  ): Promise<OperacionBajaAceptada> {
    return this.unitOfWork.enTransaccion(async (tx) => {
      const [caracteristica] = await tx
        .select()
        .from(characteristics)
        .where(eq(characteristics.id, caracteristicaId))
        .for('update');
      if (!caracteristica) {
        throw crearError(
          'CARACTERISTICA_NO_ENCONTRADA',
          'La característica no existe.',
        );
      }
      if (caracteristica.tipo !== 'LISTA') {
        throw crearError('VALIDACION', 'Solo los valores LISTA admiten baja.');
      }
      const [valor] = await tx
        .select()
        .from(characteristicValues)
        .where(
          and(
            eq(characteristicValues.id, valorId),
            eq(characteristicValues.caracteristicaId, caracteristicaId),
          ),
        )
        .for('update');
      if (!valor) {
        throw crearError('VALIDACION', 'El valor permitido no existe.');
      }
      if (valor.estado !== 'ACTIVO') {
        throw crearError(
          'VERSION_CONFLICT',
          'El valor permitido no está activo.',
        );
      }
      const version = valor.taxonomyVersion + 1;
      await tx
        .update(characteristicValues)
        .set({
          estado: 'PENDING_DEACTIVATION',
          taxonomyVersion: version,
          updatedAt: new Date(),
        })
        .where(eq(characteristicValues.id, valorId));
      return persistirSolicitudBaja(
        tx,
        TIPO_BAJA_VALOR_CARACTERISTICA,
        valorId,
        version,
        correlationId,
        reason,
      );
    });
  }

  async procesarResultadoBajaValorPermitido(
    operationId: string,
    resultado: 'CLEAR' | 'HAS_ACTIVE_PRODUCTS' | 'TIMEOUT' | 'ERROR',
    correlationId: string,
  ): Promise<EstadoMaestro> {
    return this.unitOfWork.enTransaccion(async (tx) => {
      const [operacion] = await tx
        .select()
        .from(masterDeactivationOperations)
        .where(eq(masterDeactivationOperations.operationId, operationId))
        .for('update');
      if (
        !operacion ||
        operacion.entityType !== TIPO_BAJA_VALOR_CARACTERISTICA
      ) {
        throw crearError(
          'OPERACION_MAESTRA_NO_ENCONTRADA',
          'La operación de baja no existe.',
        );
      }
      validarCorrelacionOperacion(operacion.correlationId, correlationId);
      const [valor] = await tx
        .select()
        .from(characteristicValues)
        .where(eq(characteristicValues.id, operacion.entityId))
        .for('update');
      if (!valor) {
        throw crearError('VALIDACION', 'El valor permitido no existe.');
      }
      const estado = validarResultadoBajaSegura(valor.estado, resultado);
      const operationStatus =
        estado === 'INACTIVO'
          ? 'COMPLETED'
          : resultado === 'TIMEOUT' || resultado === 'ERROR'
            ? 'FAILED'
            : 'REJECTED';
      await tx
        .update(characteristicValues)
        .set({
          estado,
          taxonomyVersion: valor.taxonomyVersion + 1,
          updatedAt: new Date(),
        })
        .where(eq(characteristicValues.id, valor.id));
      await tx
        .update(masterDeactivationOperations)
        .set({ status: operationStatus, updatedAt: new Date() })
        .where(eq(masterDeactivationOperations.operationId, operationId));
      await persistirResultadoBaja(
        tx,
        TIPO_BAJA_VALOR_CARACTERISTICA,
        valor.id,
        operationId,
        valor.taxonomyVersion + 1,
        estado,
        resultado,
        correlationId,
      );
      return estado;
    });
  }

  async reactivarValorPermitido(caracteristicaId: string, valorId: string) {
    return this.unitOfWork.enTransaccion(async (tx) => {
      const [caracteristica] = await tx
        .select()
        .from(characteristics)
        .where(eq(characteristics.id, caracteristicaId))
        .for('update');
      if (!caracteristica) {
        throw crearError(
          'CARACTERISTICA_NO_ENCONTRADA',
          'La característica no existe.',
        );
      }
      const [valor] = await tx
        .select()
        .from(characteristicValues)
        .where(
          and(
            eq(characteristicValues.id, valorId),
            eq(characteristicValues.caracteristicaId, caracteristicaId),
          ),
        )
        .for('update');
      if (!valor) {
        throw crearError('VALIDACION', 'El valor permitido no existe.');
      }
      if (valor.estado !== 'INACTIVO') {
        throw crearError(
          'VERSION_CONFLICT',
          'El valor permitido no está inactivo.',
        );
      }
      const filas = await tx
        .select()
        .from(characteristicValues)
        .where(eq(characteristicValues.caracteristicaId, caracteristicaId));
      validarValorCaracteristica(
        caracteristica,
        valor.nombre,
        filas
          .filter((fila) => fila.id !== valorId)
          .map((fila) => ({
            id: fila.id,
            caracteristicaId: fila.caracteristicaId,
            nombre: fila.nombre,
            estado: fila.estado,
          })),
      );
      const [reactivado] = await tx
        .update(characteristicValues)
        .set({
          estado: 'ACTIVO',
          taxonomyVersion: valor.taxonomyVersion + 1,
          updatedAt: new Date(),
        })
        .where(eq(characteristicValues.id, valorId))
        .returning();
      return reactivado;
    });
  }

  async crearTipoProducto(input: CrearTipoProducto) {
    validarTextoRequerido(input.nombre, 'El nombre del tipo de producto');
    return this.unitOfWork.enTransaccion(async (tx) => {
      const [fila] = await tx
        .insert(productTypes)
        .values({ nombre: input.nombre.trim(), estado: 'ACTIVO' })
        .returning();
      return fila;
    });
  }

  async asociarCaracteristica(input: AsociarCaracteristica) {
    return this.unitOfWork.enTransaccion(async (tx) => {
      const [tipoFila] = await tx
        .select()
        .from(productTypes)
        .where(eq(productTypes.id, input.tipoProductoId))
        .for('update');
      if (!tipoFila) {
        throw crearError('TIPO_PRODUCTO_NO_ENCONTRADO', 'El tipo no existe.');
      }
      validarVersion(tipoFila.schemaVersion, input.schemaVersion);
      const [caracteristicaFila] = await tx
        .select()
        .from(characteristics)
        .where(eq(characteristics.id, input.caracteristicaId));
      if (!caracteristicaFila) {
        throw crearError(
          'CARACTERISTICA_NO_ENCONTRADA',
          'La característica no existe.',
        );
      }
      const rows = await tx
        .select()
        .from(productTypeCharacteristics)
        .where(
          eq(productTypeCharacteristics.tipoProductoId, input.tipoProductoId),
        );
      const asociaciones: AsociacionTipoCaracteristica[] = rows.map((row) => ({
        tipoProductoId: row.tipoProductoId,
        caracteristicaId: row.caracteristicaId,
        obligatoria: row.obligatoria,
        estado: row.estado,
      }));
      const tipo: TipoProductoMaestro = {
        id: tipoFila.id,
        estado: tipoFila.estado,
      };
      const caracteristica: CaracteristicaMaestra = {
        id: caracteristicaFila.id,
        tipo: caracteristicaFila.tipo,
        unidadMedida: caracteristicaFila.unidadMedida,
        estado: caracteristicaFila.estado,
      };
      validarNuevaAsociacionTipoCaracteristica(
        tipo,
        caracteristica,
        asociaciones,
      );
      const asociacion = crearAsociacionTipoCaracteristica(
        input.tipoProductoId,
        input.caracteristicaId,
        input.obligatoria,
      );
      const [fila] = await tx
        .insert(productTypeCharacteristics)
        .values({
          tipoProductoId: asociacion.tipoProductoId,
          caracteristicaId: asociacion.caracteristicaId,
          obligatoria: asociacion.obligatoria,
          estado: asociacion.estado,
        })
        .returning();
      const [tipoActualizado] = await tx
        .update(productTypes)
        .set({
          schemaVersion: tipoFila.schemaVersion + 1,
          taxonomyVersion: tipoFila.taxonomyVersion + 1,
          updatedAt: new Date(),
        })
        .where(eq(productTypes.id, input.tipoProductoId))
        .returning({ schemaVersion: productTypes.schemaVersion });
      await persistirCambioEsquemaTipoProducto(tx, {
        tipoProductoId: input.tipoProductoId,
        schemaVersion: tipoActualizado.schemaVersion,
        changeType: 'ASSOCIATED',
        caracteristicaId: input.caracteristicaId,
        correlationId: input.correlationId ?? randomUUID(),
      });
      return { ...fila, schemaVersion: tipoActualizado.schemaVersion };
    });
  }

  async actualizarAsociacionCaracteristica(
    tipoProductoId: string,
    caracteristicaId: string,
    obligatoria: boolean,
    expectedSchemaVersion: number,
    correlationId = randomUUID(),
  ) {
    return this.unitOfWork.enTransaccion(async (tx) => {
      const [tipo] = await tx
        .select()
        .from(productTypes)
        .where(eq(productTypes.id, tipoProductoId))
        .for('update');
      if (!tipo) {
        throw crearError('TIPO_PRODUCTO_NO_ENCONTRADO', 'El tipo no existe.');
      }
      validarVersion(tipo.schemaVersion, expectedSchemaVersion);
      const [asociacion] = await tx
        .select()
        .from(productTypeCharacteristics)
        .where(
          and(
            eq(productTypeCharacteristics.tipoProductoId, tipoProductoId),
            eq(productTypeCharacteristics.caracteristicaId, caracteristicaId),
            eq(productTypeCharacteristics.estado, 'ACTIVO'),
          ),
        )
        .for('update');
      if (!asociacion) {
        throw crearError(
          'ASOCIACION_NO_ENCONTRADA',
          'La asociación tipo-característica no existe.',
        );
      }
      const [fila] = await tx
        .update(productTypeCharacteristics)
        .set({ obligatoria, updatedAt: new Date() })
        .where(eq(productTypeCharacteristics.id, asociacion.id))
        .returning();
      const [updatedType] = await tx
        .update(productTypes)
        .set({
          schemaVersion: tipo.schemaVersion + 1,
          taxonomyVersion: tipo.taxonomyVersion + 1,
          updatedAt: new Date(),
        })
        .where(eq(productTypes.id, tipoProductoId))
        .returning({ schemaVersion: productTypes.schemaVersion });
      await persistirCambioEsquemaTipoProducto(tx, {
        tipoProductoId,
        schemaVersion: updatedType.schemaVersion,
        changeType: 'REQUIRED_CHANGED',
        caracteristicaId,
        correlationId,
      });
      return { ...fila, schemaVersion: updatedType.schemaVersion };
    });
  }
}

async function bloquearArbolFueraDeTransaccion<T>(
  uow: TaxonomyWriteUnitOfWork,
  action: (tx: TransaccionTaxonomy) => Promise<T>,
): Promise<T> {
  return uow.enTransaccion(async (tx) => {
    await bloquearArbol(tx);
    return action(tx);
  });
}

function validarVersion(actual: number, esperada?: number): void {
  if (esperada !== undefined && actual !== esperada) {
    throw crearError('VERSION_CONFLICT', 'La versión cambió desde la lectura.');
  }
}

function validarTextoRequerido(value: string, label: string): void {
  if (!value.trim()) throw crearError('VALIDACION', `${label} es obligatorio.`);
}

function validarOrden(orden: number | undefined): void {
  if (orden !== undefined && (!Number.isInteger(orden) || orden < 0)) {
    throw crearError('VALIDACION', 'El orden debe ser un entero no negativo.');
  }
}

function validarPaisOrigen(paisOrigenIso: string | null): void {
  if (paisOrigenIso !== null && !/^[A-Z]{2}$/u.test(paisOrigenIso)) {
    throw crearError(
      'VALIDACION',
      'El país de origen debe ser ISO 3166-1 alpha-2.',
    );
  }
}

function reactivarEstadoLogico(estado: EstadoMaestro): EstadoMaestro {
  if (estado !== 'INACTIVO') {
    throw crearError('VERSION_CONFLICT', 'La entidad no está inactiva.');
  }
  return 'ACTIVO';
}

function validarCorrelacionOperacion(esperada: string, recibida: string): void {
  if (esperada !== recibida) {
    throw crearError(
      'VERSION_CONFLICT',
      'La respuesta no corresponde a la correlación de la operación.',
    );
  }
}
