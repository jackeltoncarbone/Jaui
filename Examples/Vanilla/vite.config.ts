import { defineConfig } from 'vite';
import { resolve } from 'path';
import glsl from 'vite-plugin-glsl';
import { JssPlugin } from '../../Source/Jss/Jss.VitePlugin';

/**
 * Dev config for the Jaui vanilla-TypeScript playground. Consumes the
 * Jaui lib from its source (../../Source) for fast iteration — no build
 * step between editing lib code and seeing it in the demo.
 */
export default defineConfig({
  root: __dirname,
  plugins: [JssPlugin(), glsl()],
  resolve: {
    alias: {
      jaui: resolve(__dirname, '../../Source/Core/Jaui.ts'),
      '@jaui': resolve(__dirname, '../../Source'),
    },
  },
  server: {
    port: 6777,
    host: '0.0.0.0',
  },
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        main:   resolve(__dirname, 'index.html'),
        corpus: resolve(__dirname, 'Corpus/index.html'),
      },
    },
  },
});
