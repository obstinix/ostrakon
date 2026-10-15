// `npm run test:e2e`: isolated end-to-end run.
//  1. start a fresh anvil on :8546 (never touches the dev chain on :8545)
//  2. deploy + seed the demo world
//  3. build the app with VITE_E2E=1 into dist-e2e/ (adds the test-only wallet connector)
//  4. write dist-e2e/deployment.json and serve it with `vite preview` on :4174
//  5. run Playwright, then tear everything down
process.env.OSTRAKON_RPC_PORT ??= "8546";

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { deploy, startAnvil } = await import("./lib/chain.ts");
const { seed } = await import("./lib/seed.ts");
const children: ChildProcess[] = [];
const cleanup = () => children.forEach((c) => c.exitCode === null && c.kill());
process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});

const node = process.execPath;
const bin = (p: string) => join(root, "node_modules", p);

try {
  console.log("▸ anvil :8546");
  children.push(await startAnvil());
  console.log("▸ deploy + seed");
  const deployment = await deploy();
  await seed(deployment.address);

  console.log("▸ build (VITE_E2E=1)");
  const build = spawnSync(node, [bin("vite/bin/vite.js"), "build", "--config", "web/vite.config.ts"], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, VITE_E2E: "1" },
  });
  if (build.status !== 0) throw new Error("e2e build failed");
  writeFileSync(join(root, "dist-e2e/deployment.json"), JSON.stringify(deployment, null, 2));

  console.log("▸ preview :4174");
  const preview = spawn(node, [bin("vite/bin/vite.js"), "preview", "--config", "web/vite.config.ts"], {
    cwd: root,
    stdio: "ignore",
    env: { ...process.env, VITE_E2E: "1" },
  });
  children.push(preview);
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch("http://localhost:4174/deployment.json")).ok) break;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  console.log("▸ playwright");
  const run = spawnSync(node, [bin("@playwright/test/cli.js"), "test", ...process.argv.slice(2)], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, OSTRAKON_RPC: deployment.rpcUrl, OSTRAKON_CONTRACT: deployment.address },
  });
  cleanup();
  process.exit(run.status ?? 1);
} catch (err) {
  console.error(err);
  cleanup();
  process.exit(1);
}
