// Scroll-smoothness measurement. Skipped unless PERF=1:
//   PERF=1 npm run test:e2e -- e2e/perf.spec.ts
// Chrome only (uses the DevTools protocol to slow the CPU 4x, a rough mid-range-laptop stand-in).
import { expect, test } from "@playwright/test";

test.skip(process.env.PERF !== "1", "set PERF=1 to measure scroll frame times");

for (const path of ["/e/1", "/e/6"]) {
  test(`scroll frames on ${path} at 4x CPU throttling`, async ({ page, browserName }) => {
    test.skip(browserName !== "chromium", "CDP CPU throttling is Chromium-only");
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.addInitScript(() => {
      window.__OSTRAKON_E2E__ = { mock: false };
    });
    await page.goto(path);
    await expect(page.locator(".lifecycle .block").first()).toBeVisible();
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    const r = await page.evaluate(async () => {
      window.scrollTo(0, 0);
      const max = document.documentElement.scrollHeight - innerHeight;
      const frames: number[] = [];
      let last = performance.now();
      let running = true;
      const loop = (t: number) => {
        frames.push(t - last);
        last = t;
        if (running) requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
      const steps = 240; // down and back up, one scroll step per frame (wheel/trackpad-like)
      for (let i = 0; i <= steps; i++) {
        window.scrollTo(0, (max * (i <= steps / 2 ? i : steps - i)) / (steps / 2));
        await new Promise((res) => requestAnimationFrame(res));
      }
      running = false;
      const f = frames.slice(2);
      const s = [...f].sort((a, b) => a - b);
      const p = (q: number) => s[Math.floor(q * (s.length - 1))]!;
      return {
        scrollableHeight: max,
        frames: f.length,
        p50: +p(0.5).toFixed(2),
        p95: +p(0.95).toFixed(2),
        maxMs: +Math.max(...f).toFixed(2),
        over16_7ms: f.filter((x) => x > 16.7).length,
      };
    });
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
    console.log(`PERF ${path} ${JSON.stringify(r)}`);
    expect(r.frames).toBeGreaterThan(200);
  });
}
