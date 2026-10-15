// `npm run chain:deploy`: deploy + seed onto an already-running local chain and rewrite
// web/public/deployment.json. Use it after restarting anvil while the web app keeps running.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CHAIN_ID, deploy, PORT, rpcAlive } from "./lib/chain.ts";
import { seed } from "./lib/seed.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const file = join(root, "web/public/deployment.json");

const running = await rpcAlive();
if (running !== CHAIN_ID) {
  console.error(
    running === null
      ? `Nothing is answering on :${PORT}. Start the chain with "npm run dev".`
      : `:${PORT} is chain ${running}, expected ${CHAIN_ID}.`,
  );
  process.exit(1);
}
const d = await deploy();
await seed(d.address);
mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, JSON.stringify(d, null, 2) + "\n");
console.log(`Deployed and seeded ${d.address} (block ${d.deployBlock}); wrote web/public/deployment.json`);
