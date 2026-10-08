import { defineConfig, devices } from '@playwright/test';

const PORT = 4319;

/**
 * End-to-end tests: real browsers against the production build, served by
 * `vite preview` (the Worker and Durable Objects run in the local Workers
 * runtime). Run with `npm run test:e2e`.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 45_000,
  expect: { timeout: 7_000 },
  fullyParallel: true,
  workers: 3,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `npm run build && npx vite preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/health`,
    env: { TWEETCHESS_E2E: '1' },
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
