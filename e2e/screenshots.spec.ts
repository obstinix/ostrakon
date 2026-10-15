// README screenshots. Skipped unless SHOTS=1:  SHOTS=1 npm run test:e2e -- e2e/screenshots.spec.ts
import { expect, test } from "@playwright/test";

test.skip(process.env.SHOTS !== "1", "set SHOTS=1 to regenerate docs/screenshots");
test.describe.configure({ mode: "serial" });

const out = (name: string) => `docs/screenshots/${name}.png`;

async function connect(page: import("@playwright/test").Page) {
  const btn = page.getByRole("button", { name: "Connect wallet" });
  await btn.click();
  await expect(page.getByTestId("role")).not.toHaveText("Read-only");
}

declare global {
  interface Window {
    __OSTRAKON_E2E__?: { account?: number; mock?: boolean };
  }
}

test("capture", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.emulateMedia({ reducedMotion: "reduce" }); // settled frames, no mid-animation captures
  await page.addInitScript(() => {
    window.__OSTRAKON_E2E__ = { account: 3 };
  });

  await page.goto("/");
  await connect(page);
  await expect(page.locator(".ledger-item")).toHaveCount(5);
  await page.locator(".ledger-item").nth(4).getByRole("button", { name: "On-chain record" }).click();
  await page.screenshot({ path: out("ledger"), fullPage: true });

  await page.goto("/e/1");
  await connect(page);
  await expect(page.getByTestId("eligibility")).toBeVisible();
  await page.getByTestId("candidate-1").locator(".card-face").click();
  await page.screenshot({ path: out("election") });
  await page.locator(".lifecycle").scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollBy(0, 200));
  await page.screenshot({ path: out("lifecycle") });

  await page.goto("/audit");
  await connect(page);
  await expect(page.getByTestId("verify").locator(".receipt").first()).toBeVisible();
  await page.screenshot({ path: out("audit") });

  await page.goto("/e/3");
  await expect(page.getByTestId("result")).toBeVisible();
  await page.screenshot({ path: out("result") });

  await page.setViewportSize({ width: 360, height: 780 });
  await page.goto("/");
  await expect(page.locator(".ledger-item")).toHaveCount(5);
  await page.screenshot({ path: out("mobile-ledger"), fullPage: true });
});

test("capture admin", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => {
    window.__OSTRAKON_E2E__ = { account: 1 };
  });
  await page.goto("/e/2/manage");
  await connect(page);
  await page.getByLabel(/Paste addresses/).fill(
    [
      "0x976EA74026E726554dB657fA54763abd0C3a0aa9",
      "0x14dC79964da2C08b23698B3D3cc7Ca32193d9955",
      "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
      "0x14dc79964da2c08b23698b3d3cc7ca32193d9955",
      "0x9965507d1A55bcC2695C58ba16FB37d819B0A4dc",
    ].join("\n"),
  );
  await expect(page.getByTestId("voter-preview")).toBeVisible();
  await page.screenshot({ path: out("admin") });
});
