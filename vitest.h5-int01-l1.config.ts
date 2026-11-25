import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['apps/catalog-svc/test/h5/int01-local-catalog.e2e-spec.ts'],
    reporters: [['./apps/catalog-svc/test/h5/int01-local-catalog-reporter.mjs']],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 180_000,
  },
});
