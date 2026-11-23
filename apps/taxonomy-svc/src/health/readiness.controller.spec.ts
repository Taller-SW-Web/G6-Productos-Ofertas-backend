import { Logger } from '@nestjs/common';
import { ReadinessController } from './readiness.controller.js';
import type { TaxonomyReadinessIndicator } from './readiness.port.js';
import type { TaxonomyAmqpRuntime } from '../domain/taxonomy-amqp.runtime.js';

describe('readiness de Taxonomy', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(['postgres', 'service_bus', 'amqp'] as const)(
    'devuelve 503 y distingue la dependencia %s',
    async (dependency) => {
      const warn = vi
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      const messaging = {
        disponible: () => false,
        dependenciaNoDisponible: () => dependency,
      } as unknown as TaxonomyAmqpRuntime;
      const db = {
        verificarReadiness: vi.fn(),
      } as unknown as TaxonomyReadinessIndicator;
      const controller = new ReadinessController(db, messaging);
      await expect(controller.obtenerReadiness()).rejects.toMatchObject({
        status: 503,
      });
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ component: dependency, state: 'not_ready' }),
      );
    },
  );
});
