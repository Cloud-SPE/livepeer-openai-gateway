import { defineConfig } from 'vite';

export default defineConfig({
  base: '/admin/console/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  resolve: {
    dedupe: ['lit', 'rxjs'],
  },
  server: {
    port: 5174,
    strictPort: true,
    proxy: {
      '/admin': {
        target: process.env.BRIDGE_DEV_TARGET ?? 'http://localhost:8080',
        changeOrigin: true,
      },
    },
  },
});
