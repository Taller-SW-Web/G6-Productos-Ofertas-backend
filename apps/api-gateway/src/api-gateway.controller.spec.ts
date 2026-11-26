import { Test, TestingModule } from '@nestjs/testing';
import { ApiGatewayController } from './api-gateway.controller.js';
import { ApiGatewayService } from './api-gateway.service.js';
import { GatewayReadiness } from './routing/gateway-readiness.js';

function mockResponse() {
  const res: { statusCode?: number; body?: unknown; status: (code: number) => typeof res; json: (payload: unknown) => typeof res } = {
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return res;
}

describe('ApiGatewayController', () => {
  let controller: ApiGatewayController;
  let readinessCheck: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    readinessCheck = vi.fn();
    const app: TestingModule = await Test.createTestingModule({
      controllers: [ApiGatewayController],
      providers: [
        ApiGatewayService,
        {
          provide: GatewayReadiness,
          useValue: { check: readinessCheck },
        },
      ],
    }).compile();

    controller = app.get<ApiGatewayController>(ApiGatewayController);
  });

  describe('health', () => {
    it('should return health status for api-gateway', () => {
      expect(controller.getHealth()).toEqual({
        status: 'ok',
        service: 'api-gateway',
      });
    });
  });

  describe('health/ready', () => {
    it('returns 200 when all dependencies are ready and coverage is complete', async () => {
      readinessCheck.mockResolvedValue({
        status: 'ready',
        coverage: 'complete',
        dependencies: { 'catalog-svc': 'ready' },
      });
      const res = mockResponse();
      await controller.getReadiness(res as never);
      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({
        status: 'ready',
        coverage: 'complete',
        dependencies: { 'catalog-svc': 'ready' },
        service: 'api-gateway',
      });
    });

    it('returns 503 when coverage is partial by default', async () => {
      readinessCheck.mockResolvedValue({
        status: 'ready',
        coverage: 'partial',
        dependencies: { 'catalog-svc': 'ready', 'bulk-svc': 'not_configured' },
      });
      const res = mockResponse();
      await controller.getReadiness(res as never);
      expect(res.statusCode).toBe(503);
      expect(res.body).toEqual({
        status: 'not_ready',
        coverage: 'partial',
        dependencies: { 'catalog-svc': 'ready', 'bulk-svc': 'not_configured' },
        service: 'api-gateway',
      });
    });

    it('returns 503 when any dependency is not_ready', async () => {
      readinessCheck.mockResolvedValue({
        status: 'not_ready',
        coverage: 'complete',
        dependencies: { 'catalog-svc': 'ready', 'inventory-svc': 'not_ready' },
      });
      const res = mockResponse();
      await controller.getReadiness(res as never);
      expect(res.statusCode).toBe(503);
      expect(res.body).toEqual({
        status: 'not_ready',
        coverage: 'complete',
        dependencies: { 'catalog-svc': 'ready', 'inventory-svc': 'not_ready' },
        service: 'api-gateway',
      });
    });
  });
});
