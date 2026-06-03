import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@jaui': resolve(__dirname, 'Source'),
    },
  },
  test: {
    include: ['Tests/**/*.test.ts'],
    // Parity.test.ts is a Playwright test (browser + GPU), run via
    // `npx playwright test`, not vitest. Exclude it from the unit suite.
    exclude: ['Tests/Parity.test.ts', '**/node_modules/**'],
    setupFiles: ['./Tests/setup.ts'],
  },
});
