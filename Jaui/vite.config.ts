import { defineConfig } from 'vite';
import { resolve } from 'path';
import { JssPlugin } from './src/Jss/Jss.VitePlugin';

export default defineConfig({
  root: resolve(__dirname, 'playground'),
  plugins: [JssPlugin()],
  resolve: {
    alias: {
      '@jaui': resolve(__dirname, 'src'),
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
