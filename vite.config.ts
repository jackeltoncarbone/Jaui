import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  root: resolve(__dirname, 'playground'),
  resolve: {
    alias: {
      '@jwift': resolve(__dirname, 'src'),
    },
  },
  server: {
    port: 6777,
    host: '0.0.0.0',   // bind all interfaces so Tailscale / LAN can reach it
  },
  build: {
    target: 'es2022',
  },
});
