/**
 * Playwright config for the real-browser multipart suite.
 *
 * The webServer command starts BOTH the mock object-storage bucket and the real
 * CineVerse server in test mode (see scripts/browser/serve-test-stack.mjs), so a
 * Chromium browser drives the ACTUAL room UI against a real cross-origin bucket
 * without S3 credentials. `next dev` compiles routes on first hit, so timeouts are
 * generous.
 */

import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.BROWSER_TEST_PORT) || 3999;
const BASE = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './scripts/browser',
  testMatch: /.*\.spec\.mjs/,
  // One worker: the two-member scenarios open several contexts and share one
  // in-memory server; parallel files would race the same rooms and bucket.
  workers: 1,
  fullyParallel: false,
  forbidOnly: true,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: [['list'], ['json', { outputFile: '.artifacts/browser/results.json' }]],
  use: {
    baseURL: BASE,
    headless: true,
    viewport: { width: 1280, height: 800 },
    actionTimeout: 20_000,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'node scripts/browser/serve-test-stack.mjs',
    url: `${BASE}/readyz`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
