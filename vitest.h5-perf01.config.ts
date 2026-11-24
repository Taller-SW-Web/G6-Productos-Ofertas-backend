import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['apps/catalog-svc/test/performance/h5/catalog-pagination-integrity.h5.ts'],
    reporters: [['./apps/catalog-svc/test/h5/safe-reporter.mjs', {
      suite: 'PERF01_ORACLE',
      expectedTests: 14,
      summaryPath: process.env.G6_H5_VITEST_SUMMARY ?? 'apps/catalog-svc/test/h5/reports/perf01.json',
    }]],
    fileParallelism: false,
  },
});
