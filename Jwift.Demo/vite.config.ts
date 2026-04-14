import { defineConfig } from 'vite';
import { resolve } from 'path';
import glsl from 'vite-plugin-glsl';
import { JssPlugin } from '../Jwift/src/Jss/Jss.VitePlugin';

/**
 * Dev config for the Jwift vanilla-TypeScript playground. Consumes the
 * Jwift lib from its source (../Jwift/src) for fast iteration — no build
 * step between editing lib code and seeing it in the demo.
 */
export default defineConfig({
  root: __dirname,
  plugins: [JssPlugin(), glsl()],
  resolve: {
    alias: {
      jwift: resolve(__dirname, '../Jwift/src/Core/Jwift.ts'),
      '@jwift': resolve(__dirname, '../Jwift/src'),
    },
  },
  server: {
    port: 6777,
    host: '0.0.0.0',
  },
  build: {
    target: 'es2022',
  },
});
