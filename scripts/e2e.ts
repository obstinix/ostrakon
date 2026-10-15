// `npm run test:e2e` (Chrome) / `npm run test:e2e:all` (every browser project): isolated runs.
//  1. build the app with VITE_E2E=1 into dist-e2e/ (adds the test-only wallet connector) and serve
//     it with `vite preview` on :4174
//  2. for each Playwright project: start a fresh anvil on :8546 (never the dev chain on :8545),
//     deploy + seed the demo world, write dist-e2e/deployment.json, run that project, stop anvil
// Usage: tsx scripts/e2e.ts [--all | --projects=a,b] [playwright args...]
process.env.OSTRAKON_RPC_PORT ??= "8546";

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, writeFileSync } from "node:fs";
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

const ALL = ["chrome", "firefox", "webkit", "mobile-chrome", "mobile-safari"];
const args = process.argv.slice(2);
const projectsArg = args.find((a) => a.startsWith("--projects="));
const projects = args.includes("--all") ? ALL : projectsArg ? projectsArg.slice(11).split(",") : ["chrome"];
const pwArgs = args.filter((a) => a !== "--all" && !a.startsWith("--projects="));

const node = process.execPath;
const bin = (p: string) => join(root, "node_modules", p);

async function freshChain() {
  const anvil = await startAnvil();
  children.push(anvil);
  const deployment = await deploy();
  await seed(deployment.address); // also (re)writes web/public/allowlists/7.json
  writeFileSync(join(root, "dist-e2e/deployment.json"), JSON.stringify(deployment, null, 2));
  const tree = join(root, "web/public/allowlists");
  if (existsSync(tree)) cpSync(tree, join(root, "dist-e2e/allowlists"), { recursive: true });
  return { anvil, deployment };
}

const results: { project: string; status: number }[] = [];
try {
  console.log("▸ build (VITE_E2E=1)");
  const build = spawnSync(node, [bin("vite/bin/vite.js"), "build", "--config", "web/vite.config.ts"], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, VITE_E2E: "1" },
  });
  if (build.status !== 0) throw new Error("e2e build failed");

  console.log("▸ preview :4174");
  const preview = spawn(node, [bin("vite/bin/vite.js"), "preview", "--config", "web/vite.config.ts"], {
    cwd: root,
    stdio: "ignore",
    env: { ...process.env, VITE_E2E: "1" },
  });
  children.push(preview);
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch("http://localhost:4174/")).ok) break;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  for (const project of projects) {
    console.log(`\n▸ ${project}: fresh anvil :8546, deploy + seed`);
    const { anvil, deployment } = await freshChain();
    const run = spawnSync(node, [bin("@playwright/test/cli.js"), "test", `--project=${project}`, ...pwArgs], {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, OSTRAKON_RPC: deployment.rpcUrl, OSTRAKON_CONTRACT: deployment.address },
    });
    results.push({ project, status: run.status ?? 1 });
    anvil.kill();
    await new Promise((r) => setTimeout(r, 500)); // let the port free up
  }
  cleanup();
  console.log("\n▸ summary");
  for (const r of results) console.log(`  ${r.status === 0 ? "pass" : "FAIL"}  ${r.project}`);
  process.exit(results.every((r) => r.status === 0) ? 0 : 1);
} catch (err) {
  console.error(err);
  cleanup();
  process.exit(1);
}
