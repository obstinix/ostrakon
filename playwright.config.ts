import { defineConfig, devices } from "@playwright/test";

// Run through `npm run test:e2e`, which prepares the chain, the E2E build and the preview server.
// Uses the locally installed Chrome by default; set PW_CHANNEL="" to use Playwright's Chromium
// (after `npx playwright install chromium`).
const channel = process.env.PW_CHANNEL ?? "chrome";

export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  workers: 1, // tests share one chain and run in order
  retries: 0,
  timeout: 45_000,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://localhost:4174",
    trace: "retain-on-failure",
    ...(channel ? { channel } : {}),
  },
  projects: [{ name: "desktop", use: { ...devices["Desktop Chrome"], ...(channel ? { channel } : {}) } }],
});
