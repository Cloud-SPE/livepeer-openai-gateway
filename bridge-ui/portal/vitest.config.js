import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // Vitest restricts file-loading to the project root by default. The shared
  // module sits at ../shared, so we widen the allow list.
  server: {
    fs: {
      allow: [resolve(here, '..')],
    },
  },
  test: {
    include: ['tests/**/*.test.js', 'lib/**/*.test.js', '../shared/**/*.test.js'],
    // Web Test Runner owns tests/wtr/** — those tests need a real browser.
    exclude: ['tests/wtr/**', 'node_modules/**'],
    environment: 'jsdom',
    globals: false,
  },
});
