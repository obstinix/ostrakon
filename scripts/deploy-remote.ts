// `npm run deploy:remote`: deploy Ostrakon to any EVM chain and write a deployment.json the app can load.
// Dry run unless --yes is passed. Nothing is seeded: a real deployment starts empty.
//
//   OSTRAKON_DEPLOY_RPC   RPC URL used to deploy (may contain an API key; never written to the output)
//   OSTRAKON_DEPLOY_KEY   deployer private key, 0x-prefixed (read from the environment, never printed)
//   OSTRAKON_PUBLIC_RPC   RPC URL written into deployment.json for browsers (required off the local chain)
//   OSTRAKON_PUBLIC_WS    optional WebSocket URL for browsers
//   OSTRAKON_CHAIN_NAME   optional display name (default "Chain <id>")
//
//   npm run deploy:remote -- [--yes] [--out <file>]     (default out: deployment.<chainId>.json)
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createPublicClient, createWalletClient, defineChain, formatEther, http, isHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { parseDeployment, type Deployment } from "../web/src/chain/deployment.ts";
import { ostrakonAbi } from "../web/src/generated/ostrakonAbi.ts";
import { ostrakonBytecode } from "../web/src/generated/ostrakonBytecode.ts";
import { account, CHAIN_ID as LOCAL_CHAIN_ID } from "./lib/chain.ts";

function fail(msg: string): never {
  console.error(`deploy: ${msg}`);
  process.exit(1);
}

const args = process.argv.slice(2);
const send = args.includes("--yes");
const outIdx = args.indexOf("--out");
const outArg = outIdx >= 0 ? args[outIdx + 1] : undefined;
if (outIdx >= 0 && !outArg) fail("--out needs a file name");

const rpc = process.env.OSTRAKON_DEPLOY_RPC;
const key = process.env.OSTRAKON_DEPLOY_KEY;
if (!rpc) fail("set OSTRAKON_DEPLOY_RPC to the RPC URL to deploy through");
if (!key || !isHex(key) || key.length !== 66) fail("set OSTRAKON_DEPLOY_KEY to a 0x-prefixed 32-byte private key");

const deployer = privateKeyToAccount(key as Hex);
const probe = createPublicClient({ transport: http(rpc, { timeout: 15_000 }) });
let chainId: number;
try {
  chainId = await probe.getChainId();
} catch {
  fail("the RPC did not answer eth_chainId");
}
const local = chainId === LOCAL_CHAIN_ID;

// Anvil's keys come from a published mnemonic: anything sent to them on a real chain is taken at once.
const anvilKeys = new Set(Array.from({ length: 20 }, (_, i) => account(i).address.toLowerCase()));
if (!local && anvilKeys.has(deployer.address.toLowerCase())) {
  fail(`refusing to deploy to chain ${chainId} from an Anvil test key (its private key is public)`);
}

// `||`, not `??`: an empty variable counts as unset.
const publicRpc = process.env.OSTRAKON_PUBLIC_RPC || (local ? rpc : undefined);
if (!publicRpc) {
  fail("set OSTRAKON_PUBLIC_RPC: the deploy RPC may carry an API key, so it is never written to deployment.json");
}
const publicWs = process.env.OSTRAKON_PUBLIC_WS || undefined;
const chainName = process.env.OSTRAKON_CHAIN_NAME || `Chain ${chainId}`;
const chain = defineChain({
  id: chainId,
  name: chainName,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [rpc] } },
});
const pc = createPublicClient({ chain, transport: http(rpc, { timeout: 30_000 }) });

const [balance, gas, fees] = await Promise.all([
  pc.getBalance({ address: deployer.address }),
  pc.estimateGas({ account: deployer.address, data: ostrakonBytecode }),
  pc.estimateFeesPerGas().catch(() => null),
]);
const price = fees?.maxFeePerGas ?? (await pc.getGasPrice());
const cost = gas * price;

console.log(`chain        ${chainName} (id ${chainId})`);
console.log(`deployer     ${deployer.address}`);
console.log(`balance      ${formatEther(balance)}`);
console.log(`gas          ${gas} at up to ${formatEther(price)} per gas ≈ ${formatEther(cost)}`);
console.log(`public RPC   ${publicRpc}${publicWs ? `\npublic WS    ${publicWs}` : ""}`);
if (balance < cost) fail("the deployer's balance doesn't cover the estimated cost");

if (!send) {
  console.log("\nDry run: nothing was sent. Re-run with --yes to deploy.");
  process.exit(0);
}

const wallet = createWalletClient({ account: deployer, chain, transport: http(rpc, { timeout: 30_000 }) });
const hash = await wallet.deployContract({ abi: ostrakonAbi, bytecode: ostrakonBytecode });
console.log(`sent         ${hash}`);
const receipt = await pc.waitForTransactionReceipt({ hash, timeout: 300_000 });
if (receipt.status !== "success" || !receipt.contractAddress) fail(`deployment transaction ${hash} failed`);
const code = await pc.getCode({ address: receipt.contractAddress });
if (!code || code === "0x") fail(`no code at ${receipt.contractAddress} after deployment`);

const deployment: Deployment = {
  chainId,
  chainName,
  rpcUrl: publicRpc,
  ...(publicWs ? { wsUrl: publicWs } : {}),
  address: receipt.contractAddress,
  deployBlock: receipt.blockNumber.toString(),
  deployTx: hash,
  deployedAt: new Date().toISOString(),
};
if (!parseDeployment(deployment)) fail("internal: the deployment record doesn't match the app's schema");
const out = resolve(outArg ?? `deployment.${chainId}.json`);
writeFileSync(out, JSON.stringify(deployment, null, 2) + "\n");
console.log(`deployed     ${receipt.contractAddress} (block ${receipt.blockNumber})`);
console.log(`wrote        ${out}\nCopy it to dist/deployment.json next to the static build.`);
