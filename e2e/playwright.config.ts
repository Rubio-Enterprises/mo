import { defineConfig, devices } from "playwright/test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Playwright config for mo end-to-end tests.
 *
 * Conventions:
 *  - Tests assume the `mo` binary has been built at <repo-root>/mo.
 *  - The mo server is started per-worker via a fixture (see fixtures.ts) so
 *    tests can run in parallel against isolated ports.
 *  - State (XDG_STATE_HOME) is redirected to a tmp dir per-worker for hermeticity.
 */

const REPO_ROOT = resolve(__dirname, "..");

export default defineConfig({
  testDir: "./tests",
  // Each test starts its own mo server, so parallel runs are safe.
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [["dot"], ["list"]] : "list",

  use: {
    // BaseURL is overridden per-test via the moServer fixture.
    actionTimeout: 5_000,
    navigationTimeout: 10_000,
    trace: process.env.CI ? "on-first-retry" : "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },

  // Set REPO_ROOT for fixtures to find the binary and testdata.
  metadata: {
    repoRoot: REPO_ROOT,
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],

  outputDir: "./test-results",

  // We do NOT start a single shared server here; each test brings up its own
  // via the moServer fixture (see tests/fixtures.ts).
});
