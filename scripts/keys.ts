// Prints the demo accounts' private keys for importing into a browser wallet.
// These are anvil's PUBLIC test keys. Anyone can spend funds sent to them on a real network.
import { toHex } from "viem";
import { account } from "./lib/chain.ts";
import { ROLES } from "./lib/seed.ts";

console.log("Anvil test accounts (local development only, publicly known keys):\n");
for (const [i, role] of Object.entries(ROLES)) {
  const a = account(Number(i));
  const key = a.getHdKey().privateKey;
  console.log(`#${i}  ${a.address}`);
  console.log(`    key  ${key ? toHex(key) : "(unavailable)"}`);
  console.log(`    role ${role}\n`);
}
