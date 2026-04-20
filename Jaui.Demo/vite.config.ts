import { defineConfig } from 'vite';
import { resolve } from 'path';
import glsl from 'vite-plugin-glsl';
import { JssPlugin } from '../Jaui/src/Jss/Jss.VitePlugin';

/**
 * Dev config for the Jaui vanilla-TypeScript playground. Consumes the
 * Jaui lib from its source (../Jaui/src) for fast iteration — no build
 * step between editing lib code and seeing it in the demo.
 */
export default defineConfig({
  root: __dirname,
  plugins: [JssPlugin(), glsl()],
  resolve: {
    alias: {
      jaui: resolve(__dirname, '../Jaui/src/Core/Jaui.ts'),
      '@jaui': resolve(__dirname, '../Jaui/src'),
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
