import { realpathSync } from 'node:fs';
import { dirname } from 'node:path';
import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

process.env.NODE_ENV ??= 'test';
const vitestRoot = dirname(realpathSync('node_modules/vitest/package.json'));

export default defineConfig({
  // Resolves the path aliases declared in tsconfig.json, including the ones
  // added by `nest g library`.
  plugins: [tsconfigPaths()],
  resolve: {
    alias: {
      vitest: vitestRoot,
    },
  },
  test: {
    globals: true,
    root: './',
    include: ['**/*.spec.ts'],
    exclude: ['**/*.e2e-spec.ts', 'node_modules/**', '.ci/**'],
  },
});
