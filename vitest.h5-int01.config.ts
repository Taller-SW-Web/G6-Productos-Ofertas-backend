import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['apps/catalog-svc/test/h5/int01.contract.ts'],
    reporters: [['./apps/catalog-svc/test/h5/safe-reporter.mjs', {
      suite: 'INT01_CONTRACT',
      expectedTests: 10,
      summaryPath: process.env.G6_H5_VITEST_SUMMARY ?? 'apps/catalog-svc/test/h5/reports/int01.json',
    }]],
    fileParallelism: false,
  },
});
