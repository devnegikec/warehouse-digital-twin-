import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end configuration.
 *
 * Deliberately **not** part of `npm run verify`. These tests need a browser download and a
 * dev server, which makes them slow and environment-sensitive; folding them into the main
 * check would make `verify` something people avoid running. They are their own command:
 * `npm run test:e2e`.
 *
 * `reuseExistingServer` means a dev server already running is used instead of starting a
 * second one, so this works both in CI and on a machine where `npm run dev` is already up.
 *
 * The port is pinned rather than left to Vite's default. A stale dev server squatting on
 * 5173 makes Vite silently pick 5174, and Playwright then waits forever on a port nothing
 * is serving — a failure that looks like a broken test rather than a busy port. `--host
 * 127.0.0.1` is the same caution for IPv6: a server bound only to `::1` is unreachable at
 * `127.0.0.1`, which is the address Playwright probes.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:5180',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // A viewport wide enough that both side panels are visible. Below ~1180 px the
        // inspector is hidden by design, and tests that need it would fail for a reason
        // that has nothing to do with what they check.
        viewport: { width: 1600, height: 900 },
      },
    },
  ],
  webServer: {
    command: 'npm run dev -- --port 5180 --strictPort --host 127.0.0.1',
    url: 'http://127.0.0.1:5180',
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
