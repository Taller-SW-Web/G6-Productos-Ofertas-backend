import { Inject, Injectable } from '@nestjs/common';
import { GATEWAY_SETTINGS, type GatewaySettings } from './gateway-settings.js';
import { CONTRACT_ROUTES } from './contract-routes.js';
import { readLimitedResponse } from './bounded-response.js';

type DependencyState = 'ready' | 'not_ready' | 'unverified' | 'not_configured';

@Injectable()
export class GatewayReadiness {
  constructor(
    @Inject(GATEWAY_SETTINGS) private readonly settings: GatewaySettings,
  ) {}
  async check() {
    const dependencies: Record<string, DependencyState> = Object.fromEntries(
      await Promise.all(
        [...new Set(CONTRACT_ROUTES.map((route) => route.service))].map(
          async (name): Promise<[string, DependencyState]> => {
            const origin = this.settings.upstreams[name];
            if (!origin) return [name, 'not_configured'];
            const path = this.settings.readinessPaths?.[name];
            if (!path) return [name, 'unverified'];
            try {
              const response = await fetch(new URL(path, origin), {
                redirect: 'error',
                signal: AbortSignal.timeout(this.settings.timeoutMs),
              });
              if (
                response.status !== 200 ||
                response.headers
                  .get('content-type')
                  ?.split(';')[0]
                  .trim()
                  .toLowerCase() !== 'application/json'
              ) {
                await response.body?.cancel();
                return [name, 'not_ready'];
              }
              const payload: unknown = JSON.parse(
                (await readLimitedResponse(response, 16384)).toString('utf8'),
              );
              return [
                name,
                payload &&
                typeof payload === 'object' &&
                'status' in payload &&
                payload.status === 'ready'
                  ? 'ready'
                  : 'not_ready',
              ];
            } catch {
              return [name, 'not_ready'];
            }
          },
        ),
      ),
    );
    const enabled = Object.values(dependencies).filter(
      (status) => status !== 'not_configured',
    );
    return {
      status:
        enabled.length > 0 && enabled.every((status) => status === 'ready')
          ? 'ready'
          : 'not_ready',
      dependencies,
      coverage:
        enabled.length === Object.keys(dependencies).length
          ? 'complete'
          : 'partial',
    };
  }
}
