import { defineConfig } from 'vite';

export default defineConfig({
  server: { host: true, port: 3020 },
  build: { outDir: 'dist' },
});
