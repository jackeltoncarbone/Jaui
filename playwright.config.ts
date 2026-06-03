// How to start the servers before running this suite:
//
//   Copy server  (WebGL2 reference, port 5173):
//     cd "Jaui Copy/Examples/Vanilla"
//     npx vite --port 5173
//
//   New server   (Three.js migration, port 5174):
//     cd "Jaui/Examples/Vanilla"
//     npx vite --port 5174
//
// Then in a third terminal (from Jaui/):
//   npx playwright test Tests/Parity.test.ts

import { defineConfig, devices } from 'playwright/test';

export default defineConfig({
  testDir: './Tests',
  testMatch: '**/Parity.test.ts',

  // Snapshots live beside the test file for easy review.
  snapshotDir: './Tests/__snapshots__',

  // Generous timeout: shader compilation on first paint can be slow.
  timeout: 60_000,

  // Serial execution — both servers are hit concurrently inside each test;
  // running tests in parallel would race the same ports.
  workers: 1,
  fullyParallel: false,

  // Never auto-retry parity failures — a diff is a real regression signal.
  retries: 0,

  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],

  outputDir: './playwright-results',

  use: {
    headless: true,
    viewport: { width: 1280, height: 720 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
  },

  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 720 },
        launchOptions: {
          args: [
            '--enable-gpu',
            '--use-gl=swiftshader',  // Software GL — works in headless / CI without a physical GPU.
            '--no-sandbox',
          ],
        },
      },
    },
  ],
});
