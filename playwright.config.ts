import { defineConfig, devices } from "@playwright/test";

// Run through `npm run test:e2e` (Chrome) or `npm run test:e2e:all` (every project below). The
// harness (scripts/e2e.ts) gives each project a freshly seeded chain, because the tests change
// chain state. Desktop and mobile Chrome use the locally installed Chrome by default; set
// PW_CHANNEL="" to use Playwright's Chromium (after `npx playwright install chromium`).
// Firefox and WebKit need `npx playwright install firefox webkit`.
const channel = process.env.PW_CHANNEL ?? "chrome";
const chrome = channel ? { channel } : {};

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
  },
  projects: [
    { name: "chrome", use: { ...devices["Desktop Chrome"], ...chrome } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
    { name: "mobile-chrome", use: { ...devices["Pixel 7"], ...chrome } },
    { name: "mobile-safari", use: { ...devices["iPhone 14"] } },
  ],
});
