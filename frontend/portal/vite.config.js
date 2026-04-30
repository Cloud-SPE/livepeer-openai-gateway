import { defineConfig } from 'vite';

export default defineConfig({
  base: '/portal/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  resolve: {
    // Force a single copy of lit and rxjs even though they appear in both
    // portal/node_modules and shared/node_modules. dedupe is applied at
    // optimization time and de-duplicates package instances at the bundler.
    dedupe: ['lit', 'rxjs'],
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/v1': {
        target: process.env.BRIDGE_DEV_TARGET ?? 'http://localhost:8080',
        changeOrigin: true,
      },
    },
  },
});
