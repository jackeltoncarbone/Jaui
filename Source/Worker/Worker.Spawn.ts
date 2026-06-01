/**
 * Worker.Spawn — factory that constructs the Jaui worker using the
 * static-URL-with-import.meta pattern that modern bundlers (esbuild,
 * Vite, Webpack 5+) recognize at build time and split into a separate
 * worker chunk.
 *
 * Consumers (Angular `<jaui>`) call `SpawnJauiWorker()` rather than
 * threading a URL through props — keeps the bundler-coupled detail
 * inside the Jaui package.
 */

export const SpawnJauiWorker = (): Worker => {
  // The bundler statically analyzes this constructor and emits a
  // separate worker bundle with the resolved entry. Both esbuild
  // (Angular CLI 17+) and Vite handle this path-style construction.
  return new Worker(new URL('./Jaui.Worker.ts', import.meta.url), { type: 'module' });
};
