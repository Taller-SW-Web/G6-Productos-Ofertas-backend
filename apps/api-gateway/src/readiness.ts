import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { GatewayReadiness } from './routing/gateway-readiness.js';
import {
  readGatewayEnvironment,
  readGatewaySettings,
  readGatewayPort,
} from './routing/gateway-settings.js';
import { readLimitedResponse } from './routing/bounded-response.js';

// Container-exec healthcheck: no listener, app bootstrap, JWT or public endpoint.
export async function runGatewayReadiness(): Promise<number> {
  try {
    const environment = readGatewayEnvironment();
    const settings = readGatewaySettings(environment);
    const port = readGatewayPort(environment);
    let gateway: 'live' | 'not_live' = 'not_live';
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        redirect: 'error',
        signal: AbortSignal.timeout(settings.timeoutMs),
      });
      const payload: unknown = JSON.parse(
        (await readLimitedResponse(response, 16384)).toString('utf8'),
      );
      if (
        response.status === 200 &&
        payload &&
        typeof payload === 'object' &&
        'status' in payload &&
        payload.status === 'ok' &&
        'service' in payload &&
        payload.service === 'api-gateway'
      )
        gateway = 'live';
    } catch {
      /* Liveness is independent from provider readiness. */
    }
    const dependencies = await new GatewayReadiness(settings).check();
    const result = {
      ...dependencies,
      gateway,
      status:
        gateway === 'live' && dependencies.status === 'ready'
          ? 'ready'
          : 'not_ready',
    };
    process.stdout.write(
      JSON.stringify({ service: 'api-gateway', ...result }) + '\n',
    );
    return result.status === 'ready' ? 0 : 1;
  } catch {
    process.stdout.write(
      JSON.stringify({
        service: 'api-gateway',
        status: 'not_ready',
        code: 'INVALID_READINESS_CONFIGURATION',
      }) + '\n',
    );
    return 1;
  }
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  process.exitCode = await runGatewayReadiness();
}
