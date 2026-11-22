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
      ...(process.env.G6_SKIP_H4_AMQP_E2E === '1'
        ? [
            'apps/catalog-svc/test/rabbitmq.e2e-spec.ts',
            'apps/catalog-svc/test/postgres.persistence.e2e-spec.ts',
          ]
        : []),
    ],
  },
});
