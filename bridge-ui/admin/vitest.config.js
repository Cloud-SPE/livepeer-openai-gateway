import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  server: { fs: { allow: [resolve(here, '..')] } },
  test: {
    include: ['tests/**/*.test.js', 'lib/**/*.test.js', '../shared/**/*.test.js'],
    exclude: ['tests/wtr/**', 'node_modules/**'],
    environment: 'jsdom',
    globals: false,
  },
});
