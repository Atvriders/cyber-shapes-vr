import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [basicSsl()],
  resolve: {
    alias: {
      // Resolve shared package to its TypeScript source so vite compiles it
      // directly into the client bundle — no packages/shared/dist prebuild needed.
      '@cyber-shapes/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)),
    },
  },
  server: {
    host: true,
    port: 3020,
  },
  build: {
    outDir: 'dist',
  },
});
