import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    exclude: [
      '.ci/**',
      ...(process.env.COMBOS_RUN_ISOLATED_E2E === '1'
        ? []
        : [
            'apps/combos-svc/test/combos-postgres.e2e-spec.ts',
            'apps/combos-svc/test/combos-rabbitmq.e2e-spec.ts',
            'apps/combos-svc/test/combos-catalog-rabbitmq.e2e-spec.ts',
          ]),
      ...(process.env.COMBOS_RUN_ISOLATED_E2E === '1' &&
      process.env.COMBOS_TEST_MODE === 'postgres-only' &&
      process.env.G6_PERFORMANCE_HTTP === '1'
        ? []
        : ['apps/combos-svc/test/combos-h5-performance.e2e-spec.ts']),
    ],
  },
});
