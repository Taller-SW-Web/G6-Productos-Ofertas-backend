import { realpathSync } from 'node:fs';
import { dirname } from 'node:path';
import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

const vitestRoot = dirname(realpathSync('node_modules/vitest/package.json'));

export default defineConfig({
  plugins: [tsconfigPaths()],
  resolve: {
    alias: {
      vitest: vitestRoot,
    },
  },
  test: {
    globals: true,
    // Disposable PostgreSQL, RabbitMQ and HTTP harnesses contend for loopback
    // ports and Docker startup capacity when files run at the same time.
    fileParallelism: false,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    exclude: [
      '.ci/**',
      ...(process.env.CATALOG_POSTGRES_ONLY === '1'
        ? [
            'apps/catalog-svc/test/rabbitmq.e2e-spec.ts',
            // Dedicated taxonomia job owns this suite; it still requires H4 isolation.
            'apps/taxonomy-svc/test/persistencia-drizzle.e2e-spec.ts',
            'apps/bulk-svc/test/bulk-messaging.e2e-spec.ts',
            'apps/bulk-svc/test/bulk-http-benchmark.e2e-spec.ts',
            'apps/price-audit-svc/test/consumer.amqp.e2e-spec.ts',
            'apps/pricing-svc/test/outbox.amqp.e2e-spec.ts',
            'apps/pricing-svc/test/inbox-consumer.amqp.e2e-spec.ts',
            'apps/pricing-svc/test/historical-initialization.e2e-spec.ts',
            'apps/pricing-svc/test/price-audit.integration.e2e-spec.ts',
            'apps/pricing-svc/test/catalog-pricing.integration.e2e-spec.ts',
          ]
        : []),
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
