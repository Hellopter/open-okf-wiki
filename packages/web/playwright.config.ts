import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const webRoot = path.dirname(fileURLToPath(import.meta.url));
const monorepoRoot = path.resolve(webRoot, "../..");
const apiPort = process.env.OKF_WIKI_PORT ?? "8787";
const vitePort = process.env.VITE_PORT ?? "5173";
const baseUrl = `http://127.0.0.1:${vitePort}`;

// Fresh home per config load so parallel CI jobs / re-runs don't share index state.
const pwHome = process.env.OKF_WIKI_HOME ?? mkdtempSync(path.join(tmpdir(), "okf-wiki-pw-home-"));

export default defineConfig({
  testDir: "./e2e",
  // Retired console/publish/layout e2e coverage is superseded by Run Workspace specs.
  testIgnore: ["**/run-console.spec.ts", "**/run-publish.spec.ts", "**/ui-layout.spec.ts"],
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // Serial until the app has safe concurrent index locking.
  workers: 1,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  timeout: 60_000,
  expect: {
    timeout: 15_000,
  },
  use: {
    baseURL: baseUrl,
    trace: "on-first-retry",
    ...devices["Desktop Chrome"],
  },
  webServer: {
    command: "node packages/web/scripts/e2e-dev.mjs",
    url: baseUrl,
    // Do not reuse a host-started server (may be live/API mode without fixture).
    reuseExistingServer: false,
    cwd: monorepoRoot,
    timeout: 180_000,
    env: {
      ...process.env,
      OKF_WIKI_PORT: apiPort,
      OKF_WIKI_HOST: "127.0.0.1",
      OKF_WIKI_HOME: pwHome,
      VITE_PORT: vitePort,
      VITE_API_PROXY_TARGET: `http://127.0.0.1:${apiPort}`,
      // Always fixture for e2e (override host env that may enable live models).
      OKF_WIKI_AGENT_MODE: "fixture",
    },
  },
});
