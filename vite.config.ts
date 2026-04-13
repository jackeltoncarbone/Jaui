import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@jwift': resolve(__dirname, 'src'),
    },
  },
  server: {
    port: 6777,
  },
  build: {
    target: 'es2022',
  },
});
