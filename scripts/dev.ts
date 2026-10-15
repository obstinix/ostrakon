// `npm run dev`: build contracts -> generate typed ABI -> start anvil -> deploy -> seed ->
// write web/public/deployment.json -> start the Vite dev server. Ctrl+C stops everything.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDeployment, type Deployment } from "../web/src/chain/deployment.ts";
import { account, CHAIN_ID, deploy, PORT, publicClient, rpcAlive, setIntervalMining, startAnvil } from "./lib/chain.ts";
import { foundryBin } from "./lib/foundry.ts";
import { ROLES, seed } from "./lib/seed.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const deploymentFile = join(root, "web/public/deployment.json");
const blockTime = Number(process.env.OSTRAKON_BLOCK_TIME ?? 2);
const children: ChildProcess[] = [];

function step(msg: string) {
  console.log(`\n▸ ${msg}`);
}

function shutdown(code = 0) {
  for (const c of children) if (c.exitCode === null) c.kill();
  process.exit(code);
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

async function existingDeployment(): Promise<Deployment | null> {
  if (!existsSync(deploymentFile)) return null;
  const d = parseDeployment(JSON.parse(readFileSync(deploymentFile, "utf8")));
  if (!d || d.chainId !== CHAIN_ID) return null;
  const code = await publicClient().getCode({ address: d.address });
  return code && code !== "0x" ? d : null;
}

async function main() {
  step("Compiling contracts (forge build)");
  const build = spawnSync(foundryBin("forge"), ["build"], { cwd: root, stdio: ["ignore", "ignore", "inherit"] });
  if (build.status !== 0) shutdown(build.status ?? 1);

  step("Generating typed ABI");
  const gen = spawnSync(process.execPath, [join(root, "node_modules/tsx/dist/cli.mjs"), "scripts/gen-abi.ts"], {
    cwd: root,
    stdio: "inherit",
  });
  if (gen.status !== 0) shutdown(gen.status ?? 1);

  let deployment: Deployment | null = null;
  const running = await rpcAlive();
  if (running !== null) {
    if (running !== CHAIN_ID) {
      console.error(`Port ${PORT} is serving chain ${running}, not ${CHAIN_ID}. Stop it or set OSTRAKON_RPC_PORT.`);
      shutdown(1);
    }
    step(`Reusing the chain already running on :${PORT}`);
    deployment = await existingDeployment();
    if (deployment) console.log(`  Found Ostrakon at ${deployment.address}; keeping its state.`);
  } else {
    step(`Starting anvil on :${PORT} (chain ${CHAIN_ID})`);
    children.push(await startAnvil());
  }

  if (!deployment) {
    step("Deploying Ostrakon");
    deployment = await deploy();
    console.log(`  ${deployment.address} (block ${deployment.deployBlock})`);
    step("Seeding demo elections");
    await seed(deployment.address);
    mkdirSync(dirname(deploymentFile), { recursive: true });
    writeFileSync(deploymentFile, JSON.stringify(deployment, null, 2) + "\n");
    console.log("  wrote web/public/deployment.json");
  }

  if (blockTime > 0) await setIntervalMining(blockTime);

  console.log("\nDemo accounts (anvil's public test keys: never use them on a real network):");
  for (const [i, role] of Object.entries(ROLES)) {
    const a = account(Number(i));
    console.log(`  #${i} ${a.address}  ${role}`);
  }
  console.log(`  Import a key into your wallet with: npm run keys`);
  console.log(`  Wallet network: RPC http://127.0.0.1:${PORT}, chain id ${CHAIN_ID} (the app can add it for you)`);

  step("Starting web app");
  const vite = spawn(process.execPath, [join(root, "node_modules/vite/bin/vite.js"), "--config", "web/vite.config.ts"], {
    cwd: root,
    stdio: "inherit",
  });
  children.push(vite);
  vite.on("exit", (code) => shutdown(code ?? 0));
}

main().catch((err: unknown) => {
  console.error(err);
  shutdown(1);
});
