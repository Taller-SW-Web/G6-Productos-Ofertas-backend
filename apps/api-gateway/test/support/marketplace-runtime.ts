import { isAbsolute } from 'node:path';
import { statSync } from 'node:fs';

// Explicit local artifacts only; no private path or another owner's source imported.
export function marketplaceRuntime(
  service: 'taxonomy' | 'catalog',
  env: NodeJS.ProcessEnv,
): { envFile: string; entrypoint: string } {
  const prefix = `MKT_${service.toUpperCase()}`;
  function file(suffix: string): string {
    const name = `${prefix}_${suffix}`;
    const value = env[name];
    if (!value || !isAbsolute(value))
      throw new Error(`Required absolute local file: ${name}`);
    try {
      if (statSync(value).isFile()) return value;
    } catch {
      // Never emit file values, driver diagnostics or configuration contents.
    }
    throw new Error(`Local file unavailable: ${name}`);
  }
  return { envFile: file('ENV_FILE'), entrypoint: file('ENTRYPOINT') };
}
