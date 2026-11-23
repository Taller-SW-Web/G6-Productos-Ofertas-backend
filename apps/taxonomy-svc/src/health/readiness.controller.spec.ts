import { Logger } from '@nestjs/common';
import { ReadinessController } from './readiness.controller.js';
import type { TaxonomyReadinessIndicator } from './readiness.port.js';
import { TaxonomyAmqpRuntime } from '../domain/taxonomy-amqp.runtime.js';
import type { TaxonomyMessageStore } from '../persistence/taxonomy-message.store.js';

describe('readiness de Taxonomy', () => {
  afterEach(() => vi.restoreAllMocks());

  it('mantiene readiness cuando Azure está configurado pero ambas direcciones están apagadas', async () => {
    const store = {} as TaxonomyMessageStore;
    const messaging = new TaxonomyAmqpRuntime(store);
    messaging.configurar({
      MESSAGING_PROVIDER: 'AZURE_SERVICE_BUS',
      TAXONOMY_SERVICE_BUS_ENABLED: 'true',
    });
    messaging.iniciar();
    const verify = vi.fn().mockResolvedValue(undefined);
    const controller = new ReadinessController(
      { verificarReadiness: verify },
      messaging,
    );
    await expect(controller.obtenerReadiness()).resolves.toEqual({
      status: 'ready',
      service: 'taxonomy-svc',
    });
    expect(verify).toHaveBeenCalledOnce();
    verify.mockRejectedValueOnce(new Error('postgres unavailable'));
    await expect(controller.obtenerReadiness()).rejects.toMatchObject({
      status: 503,
    });
    await messaging.onModuleDestroy();
  });

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
