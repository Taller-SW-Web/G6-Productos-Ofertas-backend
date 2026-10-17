import { ArgumentsHost, BadRequestException } from '@nestjs/common';
import { ProblemDetailsFilter } from './problem-details.filter.js';
import { ProblemDetailsException } from './taxonomy.errors.js';
import type { ProblemDetailsBody } from './taxonomy.errors.js';

const CORRELACION = '0c0d092e-6192-47c1-8d18-5ed0e2aa4518';

class RespuestaMock {
  codigo = 0;
  encabezado: string | undefined;
  cuerpo: ProblemDetailsBody | undefined;

  status(codigo: number) {
    this.codigo = codigo;
    return this;
  }

  header(nombre: string, valor: string) {
    this.encabezado = nombre + ': ' + valor;
    return this;
  }

  json(cuerpo: ProblemDetailsBody) {
    this.cuerpo = cuerpo;
    return this;
  }
}

function crearHost(headers: Record<string, unknown> = {}): {
  host: ArgumentsHost;
  respuesta: RespuestaMock;
} {
  const respuesta = new RespuestaMock();
  const solicitud = { headers };
  const host = {
    switchToHttp: () => ({
      getResponse: () => respuesta,
      getRequest: () => solicitud,
      getNext: () => undefined,
    }),
    getArgs: () => [],
    getArguments: () => [],
    getType: () => 'http',
  };
  return { host: host as unknown as ArgumentsHost, respuesta };
}

describe('ProblemDetailsFilter — application/problem+json (#22)', () => {
  const filtro = new ProblemDetailsFilter();

  it('mapea ProblemDetailsException.validacion a 400 VALIDACION', () => {
    const { host, respuesta } = crearHost({ 'x-correlation-id': CORRELACION });

    filtro.catch(
      ProblemDetailsException.validacion('X-Correlation-Id inválido.'),
      host,
    );

    expect(respuesta.codigo).toBe(400);
    expect(respuesta.encabezado).toBe('Content-Type: application/problem+json');
    expect(respuesta.cuerpo).toEqual({
      type: '/errores/validacion',
      title: 'Datos de entrada inválidos',
      status: 400,
      code: 'VALIDACION',
      detail: 'X-Correlation-Id inválido.',
      correlationId: CORRELACION,
    });
  });

  it('mapea ProblemDetailsException.noDisponible a 503 SERVICIO_NO_DISPONIBLE', () => {
    const { host, respuesta } = crearHost();

    filtro.catch(
      ProblemDetailsException.noDisponible('Fuente de datos no configurada'),
      host,
    );

    expect(respuesta.codigo).toBe(503);
    expect(respuesta.encabezado).toBe('Content-Type: application/problem+json');
    expect(respuesta.cuerpo).toEqual({
      type: '/errores/servicio-no-disponible',
      title: 'Servicio temporalmente no disponible',
      status: 503,
      code: 'SERVICIO_NO_DISPONIBLE',
      detail: 'Fuente de datos no configurada',
    });
  });

  it('no propaga un X-Correlation-Id que no tiene formato UUID', () => {
    const { host, respuesta } = crearHost({ 'x-correlation-id': 'no-es-uuid' });

    filtro.catch(ProblemDetailsException.validacion('Entrada inválida'), host);

    expect(respuesta.codigo).toBe(400);
    expect(respuesta.cuerpo?.correlationId).toBeUndefined();
  });

  it('acepta el encabezado alternativo correlation-id como respaldo', () => {
    const { host, respuesta } = crearHost({ 'correlation-id': CORRELACION });

    filtro.catch(ProblemDetailsException.validacion('Entrada inválida'), host);

    expect(respuesta.cuerpo?.correlationId).toBe(CORRELACION);
  });

  it('convierte un error inesperado a 500 ERROR_INTERNO sin filtrar detalle sensible', () => {
    const { host, respuesta } = crearHost({ 'x-correlation-id': CORRELACION });

    filtro.catch(
      new Error('select id from taxonomy.categories: conexion rechazada'),
      host,
    );

    expect(respuesta.codigo).toBe(500);
    expect(respuesta.encabezado).toBe('Content-Type: application/problem+json');
    expect(respuesta.cuerpo).toMatchObject({
      type: '/errores/error-interno',
      title: 'Error interno',
      status: 500,
      code: 'ERROR_INTERNO',
      correlationId: CORRELACION,
    });
    expect(respuesta.cuerpo?.detail).toBe(
      'Ha ocurrido un error interno en el servicio',
    );
    expect(respuesta.cuerpo?.detail).not.toContain('taxonomy.categories');
  });

  it('conserva el detalle cuando el error no expone datos sensibles', () => {
    const { host, respuesta } = crearHost();

    filtro.catch(new Error('catalogo de taxonomía no disponible'), host);

    expect(respuesta.codigo).toBe(500);
    expect(respuesta.cuerpo?.detail).toBe(
      'catalogo de taxonomía no disponible',
    );
  });

  it('mapea una HttpException de Nest a 400 VALIDACION', () => {
    const { host, respuesta } = crearHost();

    filtro.catch(new BadRequestException('El cuerpo es obligatorio'), host);

    expect(respuesta.codigo).toBe(400);
    expect(respuesta.cuerpo).toMatchObject({
      type: '/errores/validacion',
      status: 400,
      code: 'VALIDACION',
    });
    expect(String(respuesta.cuerpo?.detail)).toContain(
      'El cuerpo es obligatorio',
    );
  });
});
