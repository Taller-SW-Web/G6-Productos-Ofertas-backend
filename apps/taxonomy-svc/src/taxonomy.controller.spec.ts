import { Test, TestingModule } from '@nestjs/testing';
import { ProblemDetailsException } from './errors/taxonomy.errors.js';
import { TaxonomyController } from './taxonomy.controller.js';
import { TaxonomySvcService } from './taxonomy-svc.service.js';
import { TAXONOMY_REPOSITORY } from './taxonomy.repository.js';
import type {
  CategoriaRow,
  MarcaRow,
  TaxonomyRepository,
} from './taxonomy.repository.js';
import { UnconfiguredTaxonomyRepository } from './unconfigured-taxonomy.repository.js';
import { RepositorioPrueba } from '../test/repositorio-prueba.js';

const CORRELACION_VALIDA = '0c0d092e-6192-47c1-8d18-5ed0e2aa4518';

const CATEGORIAS: CategoriaRow[] = [
  {
    id: '49a1dbd0-666d-0d43-6d1e-1053d4564455',
    nombre: 'Accesorios deportivos',
    categoria_padre_id: null,
    estado: 'ACTIVO',
  },
  {
    id: 'ff68d939-49a4-5dfe-91b3-bd6ebd3747c4',
    nombre: 'Chimpunes',
    categoria_padre_id: 'cd8aa953-eafd-ce4e-628b-4988ebbcded4',
    estado: 'ACTIVO',
  },
];

const MARCAS: MarcaRow[] = [
  {
    id: '380d9fe0-0290-580a-95e6-6bcd378b9b92',
    nombre: 'Marathon',
    descripcion: 'Marca ecuatoriana de ropa y calzado deportivo.',
    pais_origen_iso: 'EC',
    estado: 'ACTIVO',
  },
  {
    id: '2ae5529a-b33e-507f-900d-b4a04fc0f831',
    nombre: 'Walon',
    descripcion: null,
    pais_origen_iso: 'PE',
    estado: 'ACTIVO',
    logo_url: 'https://cdn.example.com/walon.png',
  },
  {
    id: '514d9c18-b418-559b-a692-e304183560ad',
    nombre: 'Under Armour',
    descripcion: null,
    pais_origen_iso: 'US',
    estado: 'INACTIVO',
  },
];

async function crearModulo(
  repositorio: TaxonomyRepository,
): Promise<TestingModule> {
  return Test.createTestingModule({
    controllers: [TaxonomyController],
    providers: [
      TaxonomySvcService,
      { provide: TAXONOMY_REPOSITORY, useValue: repositorio },
    ],
  }).compile();
}

async function crearModuloSinFuente(): Promise<TestingModule> {
  return Test.createTestingModule({
    controllers: [TaxonomyController],
    providers: [
      TaxonomySvcService,
      {
        provide: TAXONOMY_REPOSITORY,
        useClass: UnconfiguredTaxonomyRepository,
      },
    ],
  }).compile();
}

async function esperarProblema(
  promesa: Promise<unknown>,
  status: number,
  code: string,
): Promise<void> {
  try {
    await promesa;
    expect.unreachable('Debía lanzar un ProblemDetailsException');
  } catch (error) {
    const problema = error as ProblemDetailsException;
    expect(problema.problem?.status).toBe(status);
    expect(problema.problem?.code).toBe(code);
  }
}

describe('TaxonomyController — lectura de categorías y marcas (#22)', () => {
  let repositorio: RepositorioPrueba;
  let controller: TaxonomyController;

  beforeEach(async () => {
    repositorio = new RepositorioPrueba();
    const modulo = await crearModulo(repositorio);
    controller = modulo.get(TaxonomyController);
  });

  describe('GET /api/v1/categorias', () => {
    it('devuelve las categorías con el DTO exacto del contrato', async () => {
      repositorio.categorias = CATEGORIAS;

      await expect(controller.listarCategorias({})).resolves.toEqual({
        categories: [
          {
            categoria_id: '49a1dbd0-666d-0d43-6d1e-1053d4564455',
            parent_id: null,
            name: 'Accesorios deportivos',
            status: 'ACTIVA',
          },
          {
            categoria_id: 'ff68d939-49a4-5dfe-91b3-bd6ebd3747c4',
            parent_id: 'cd8aa953-eafd-ce4e-628b-4988ebbcded4',
            name: 'Chimpunes',
            status: 'ACTIVA',
          },
        ],
      });
    });

    it('devuelve la lista vacía cuando no hay categorías', async () => {
      await expect(controller.listarCategorias({})).resolves.toEqual({
        categories: [],
      });
    });

    it('acepta un X-Correlation-Id con formato UUID', async () => {
      await expect(
        controller.listarCategorias({}, CORRELACION_VALIDA),
      ).resolves.toEqual({
        categories: [],
      });
    });

    it('lanza 400 VALIDACION si X-Correlation-Id no es un UUID', async () => {
      await esperarProblema(
        controller.listarCategorias({}, 'no-es-uuid'),
        400,
        'VALIDACION',
      );
    });

    it('lanza 400 VALIDACION ante un parámetro de consulta desconocido', async () => {
      await esperarProblema(
        controller.listarCategorias({ estado: 'ACTIVO' }),
        400,
        'VALIDACION',
      );
    });

    it('propaga el fallo del repositorio para que el filtro responda 500', async () => {
      repositorio.falla = true;

      await expect(controller.listarCategorias({})).rejects.toThrow(
        'rechazada',
      );
    });

    it('lanza 503 SERVICIO_NO_DISPONIBLE sin fuente de datos configurada', async () => {
      const modulo = await crearModuloSinFuente();
      const sinFuente = modulo.get(TaxonomyController);

      await esperarProblema(
        sinFuente.listarCategorias({}),
        503,
        'SERVICIO_NO_DISPONIBLE',
      );
    });
  });

  describe('GET /api/v1/marcas', () => {
    it('devuelve las marcas con el DTO exacto del contrato', async () => {
      repositorio.marcas = MARCAS;

      await expect(controller.listarMarcas({})).resolves.toEqual({
        brands: [
          {
            marca_id: '380d9fe0-0290-580a-95e6-6bcd378b9b92',
            name: 'Marathon',
            description: 'Marca ecuatoriana de ropa y calzado deportivo.',
            logo_url: null,
            country_code: 'EC',
            status: 'ACTIVA',
          },
          {
            marca_id: '2ae5529a-b33e-507f-900d-b4a04fc0f831',
            name: 'Walon',
            description: null,
            logo_url: 'https://cdn.example.com/walon.png',
            country_code: 'PE',
            status: 'ACTIVA',
          },
          {
            marca_id: '514d9c18-b418-559b-a692-e304183560ad',
            name: 'Under Armour',
            description: null,
            logo_url: null,
            country_code: 'US',
            status: 'INACTIVA',
          },
        ],
      });
    });

    it('devuelve la lista vacía cuando no hay marcas', async () => {
      await expect(controller.listarMarcas({})).resolves.toEqual({
        brands: [],
      });
    });

    it('lanza 400 VALIDACION ante un parámetro de consulta desconocido', async () => {
      await esperarProblema(
        controller.listarMarcas({ pagina: 1 }),
        400,
        'VALIDACION',
      );
    });

    it('lanza 400 VALIDACION si X-Correlation-Id no es un UUID', async () => {
      await esperarProblema(
        controller.listarMarcas({}, '0c0d'),
        400,
        'VALIDACION',
      );
    });

    it('propaga el fallo del repositorio para que el filtro responda 500', async () => {
      repositorio.falla = true;

      await expect(controller.listarMarcas({})).rejects.toThrow('rechazada');
    });

    it('lanza 503 SERVICIO_NO_DISPONIBLE sin fuente de datos configurada', async () => {
      const modulo = await crearModuloSinFuente();
      const sinFuente = modulo.get(TaxonomyController);

      await esperarProblema(
        sinFuente.listarMarcas({}),
        503,
        'SERVICIO_NO_DISPONIBLE',
      );
    });
  });
});
