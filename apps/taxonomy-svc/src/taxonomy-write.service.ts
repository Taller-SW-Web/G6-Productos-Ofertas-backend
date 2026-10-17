import { HttpStatus, Injectable } from '@nestjs/common';
import {
  TaxonomyInvariantError,
  type EstadoMaestro,
} from './domain/taxonomy-invariants.js';
import { ProblemDetailsException } from './errors/taxonomy.errors.js';
import { esFalloDeConexion } from './persistence/drizzle-taxonomy.repository.js';
import {
  TaxonomyWriteRepository,
  type AsociarCaracteristica,
  type CrearCaracteristica,
  type CrearCategoria,
  type CrearMarca,
  type CrearTipoProducto,
  type OperacionBajaAceptada,
} from './persistence/taxonomy-write.repository.js';

const ESTADO_HTTP_POR_CODIGO: Readonly<Record<string, number>> = {
  VALIDACION: HttpStatus.BAD_REQUEST,
  CATEGORIA_NO_ENCONTRADA: HttpStatus.NOT_FOUND,
  MARCA_NO_ENCONTRADA: HttpStatus.NOT_FOUND,
  CARACTERISTICA_NO_ENCONTRADA: HttpStatus.NOT_FOUND,
  TIPO_PRODUCTO_NO_ENCONTRADO: HttpStatus.NOT_FOUND,
  OPERACION_MAESTRA_NO_ENCONTRADA: HttpStatus.NOT_FOUND,
  CATEGORIA_INVALIDA: HttpStatus.UNPROCESSABLE_ENTITY,
  PROFUNDIDAD_CATEGORIA_EXCEDIDA: HttpStatus.UNPROCESSABLE_ENTITY,
  VALOR_NUMERICO_INVALIDO: HttpStatus.UNPROCESSABLE_ENTITY,
  VALOR_LISTA_LIMITE_EXCEDIDO: HttpStatus.UNPROCESSABLE_ENTITY,
  TIPO_PRODUCTO_INVALIDO: HttpStatus.UNPROCESSABLE_ENTITY,
  LIMITE_CARACTERISTICAS_EXCEDIDO: HttpStatus.UNPROCESSABLE_ENTITY,
  CATEGORIA_PADRE_INACTIVA: HttpStatus.CONFLICT,
  CATEGORIA_CON_SUBCATEGORIAS_ACTIVAS: HttpStatus.CONFLICT,
  VERSION_CONFLICT: HttpStatus.CONFLICT,
  TIPO_CARACTERISTICA_INMUTABLE: HttpStatus.CONFLICT,
  MARCA_DUPLICADA: HttpStatus.CONFLICT,
  SLUG_DUPLICADO: HttpStatus.CONFLICT,
  ASOCIACION_DUPLICADA: HttpStatus.CONFLICT,
  ASOCIACION_NO_ENCONTRADA: HttpStatus.NOT_FOUND,
  BAJA_MAESTRA_EN_PROCESO: HttpStatus.CONFLICT,
};

@Injectable()
export class TaxonomyWriteService {
  constructor(private readonly writes: TaxonomyWriteRepository) {}

  async proponerSlug(nombre: string) {
    return this.ejecutar(() => this.writes.proponerSlug(nombre));
  }

  async crearCategoria(input: CrearCategoria) {
    return this.ejecutar(() => this.writes.crearCategoria(input));
  }

  async reubicarCategoria(
    categoriaId: string,
    categoriaPadreId: string | null,
    version?: number,
  ) {
    return this.ejecutar(() =>
      this.writes.reubicarCategoria(categoriaId, categoriaPadreId, version),
    );
  }

  async reactivarCategoria(categoriaId: string, version?: number) {
    return this.ejecutar(() =>
      this.writes.reactivarCategoria(categoriaId, version),
    );
  }

  async solicitarBajaCategoria(
    categoriaId: string,
    correlationId: string,
    reason?: string | null,
  ): Promise<OperacionBajaAceptada> {
    return this.ejecutar(() =>
      this.writes.solicitarBajaCategoria(categoriaId, correlationId, reason),
    );
  }

  async procesarResultadoBajaCategoria(
    operationId: string,
    resultado: 'CLEAR' | 'HAS_ACTIVE_PRODUCTS' | 'TIMEOUT' | 'ERROR',
    correlationId: string,
  ): Promise<EstadoMaestro> {
    return this.ejecutar(() =>
      this.writes.procesarResultadoBajaCategoria(
        operationId,
        resultado,
        correlationId,
      ),
    );
  }

  async crearMarca(input: CrearMarca) {
    return this.ejecutar(() => this.writes.crearMarca(input));
  }

  async actualizarMarca(
    marcaId: string,
    input: Partial<CrearMarca> & { version?: number },
  ) {
    return this.ejecutar(() => this.writes.actualizarMarca(marcaId, input));
  }

  async solicitarBajaMarca(
    marcaId: string,
    correlationId: string,
    reason?: string | null,
  ): Promise<OperacionBajaAceptada> {
    return this.ejecutar(() =>
      this.writes.solicitarBajaMarca(marcaId, correlationId, reason),
    );
  }

  async reactivarMarca(marcaId: string, version?: number) {
    return this.ejecutar(() => this.writes.reactivarMarca(marcaId, version));
  }

  async procesarResultadoBajaMarca(
    operationId: string,
    resultado: 'CLEAR' | 'HAS_ACTIVE_PRODUCTS' | 'TIMEOUT' | 'ERROR',
    correlationId: string,
  ): Promise<EstadoMaestro> {
    return this.ejecutar(() =>
      this.writes.procesarResultadoBajaMarca(
        operationId,
        resultado,
        correlationId,
      ),
    );
  }

  async crearCaracteristica(input: CrearCaracteristica) {
    return this.ejecutar(() => this.writes.crearCaracteristica(input));
  }

  async cambiarEstadoCaracteristica(
    caracteristicaId: string,
    accion: 'desactivar' | 'reactivar',
    version?: number,
  ) {
    return this.ejecutar(() =>
      this.writes.cambiarEstadoCaracteristica(
        caracteristicaId,
        accion,
        version,
      ),
    );
  }

  async actualizarCaracteristica(
    caracteristicaId: string,
    input: {
      nombre?: string;
      tipo?: CrearCaracteristica['tipo'];
      unidadMedida?: string | null;
      version?: number;
    },
  ) {
    return this.ejecutar(() =>
      this.writes.actualizarCaracteristica(caracteristicaId, input),
    );
  }

  async crearValorPermitido(caracteristicaId: string, nombre: string) {
    return this.ejecutar(() =>
      this.writes.crearValorPermitido(caracteristicaId, nombre),
    );
  }

  async solicitarBajaValorPermitido(
    caracteristicaId: string,
    valorId: string,
    correlationId: string,
    reason?: string | null,
  ): Promise<OperacionBajaAceptada> {
    return this.ejecutar(() =>
      this.writes.solicitarBajaValorPermitido(
        caracteristicaId,
        valorId,
        correlationId,
        reason,
      ),
    );
  }

  async procesarResultadoBajaValorPermitido(
    operationId: string,
    resultado: 'CLEAR' | 'HAS_ACTIVE_PRODUCTS' | 'TIMEOUT' | 'ERROR',
    correlationId: string,
  ): Promise<EstadoMaestro> {
    return this.ejecutar(() =>
      this.writes.procesarResultadoBajaValorPermitido(
        operationId,
        resultado,
        correlationId,
      ),
    );
  }

  async reactivarValorPermitido(caracteristicaId: string, valorId: string) {
    return this.ejecutar(() =>
      this.writes.reactivarValorPermitido(caracteristicaId, valorId),
    );
  }

  async crearTipoProducto(input: CrearTipoProducto) {
    return this.ejecutar(() => this.writes.crearTipoProducto(input));
  }

  async asociarCaracteristica(input: AsociarCaracteristica) {
    return this.ejecutar(() => this.writes.asociarCaracteristica(input));
  }

  async actualizarAsociacionCaracteristica(
    tipoProductoId: string,
    caracteristicaId: string,
    obligatoria: boolean,
    schemaVersion: number,
  ) {
    return this.ejecutar(() =>
      this.writes.actualizarAsociacionCaracteristica(
        tipoProductoId,
        caracteristicaId,
        obligatoria,
        schemaVersion,
      ),
    );
  }

  private async ejecutar<T>(operacion: () => Promise<T>): Promise<T> {
    try {
      return await operacion();
    } catch (error) {
      if (esFalloDeConexion(error)) {
        throw ProblemDetailsException.noDisponible();
      }
      if (error instanceof TaxonomyInvariantError) {
        throw ProblemDetailsException.funcional(
          error.code,
          ESTADO_HTTP_POR_CODIGO[error.code] ?? HttpStatus.CONFLICT,
          error.message,
        );
      }
      throw error;
    }
  }
}
