import { Inject, Injectable } from '@nestjs/common';
import { GATEWAY_SETTINGS, type GatewaySettings } from './gateway-settings.js';

@Injectable()
export class GatewayReadiness {
  constructor(
    @Inject(GATEWAY_SETTINGS) private readonly settings: GatewaySettings,
  ) {}
  async check() {
    const dependencies = Object.fromEntries(
      await Promise.all(
        Object.entries(this.settings.upstreams).map(async ([name, origin]) => {
          try {
            const response = await fetch(new URL('/health/ready', origin), {
              redirect: 'error',
              signal: AbortSignal.timeout(this.settings.timeoutMs),
            });
            await response.body?.cancel();
            return [name, response.status === 200 ? 'ready' : 'not_ready'];
          } catch {
            return [name, 'not_ready'];
          }
        }),
      ),
    );
    return {
      status:
        Object.keys(dependencies).length > 0 &&
        Object.values(dependencies).every((s) => s === 'ready')
          ? 'ready'
          : 'not_ready',
      dependencies,
    };
  }
}
