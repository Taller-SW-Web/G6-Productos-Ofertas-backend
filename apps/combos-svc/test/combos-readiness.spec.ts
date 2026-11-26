import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('Combos readiness prefix exclusion (R2-09)', () => {
  it('excludes health, ready and health/ready from the api/v1 global prefix', () => {
    const mainSource = readFileSync(
      resolve(process.cwd(), 'apps/combos-svc/src/main.ts'),
      'utf8',
    );
    expect(mainSource).toContain(
      "app.setGlobalPrefix('api/v1', { exclude: ['health', 'ready', 'health/ready'] })",
    );
  });
});
