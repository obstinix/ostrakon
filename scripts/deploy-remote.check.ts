// `npm run test:deploy`: exercises scripts/deploy-remote.ts against a throwaway anvil that pretends to be
// another network (chain id 4242), so every guard for real chains is active. Nothing leaves this machine.
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http, toHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { parseDeployment } from "../web/src/chain/deployment.ts";
import { foundryBin } from "./lib/foundry.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8548; // 8545 dev, 8546 E2E, 8547 lifecycle
const CHAIN = 4242;
const rpc = `http://127.0.0.1:${PORT}`;
const secretRpc = `${rpc}/?apikey=do-not-leak`;
const publicRpc = "https://rpc.example.invalid";
const anvilKey0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // public test key

let passed = 0;
function check(cond: boolean, what: string, detail = "") {
  if (!cond) {
    console.error(`FAIL  ${what}${detail ? `\n${detail}` : ""}`);
    shutdown(1);
  }
  passed++;
  console.log(`ok    ${what}`);
}

const anvil = spawn(foundryBin("anvil"), ["--port", String(PORT), "--chain-id", String(CHAIN), "--silent"], {
  stdio: "ignore",
});
const tmp = mkdtempSync(join(tmpdir(), "ostrakon-deploy-"));
function shutdown(code: number): never {
  anvil.kill();
  rmSync(tmp, { recursive: true, force: true });
  process.exit(code);
}

const pc = createPublicClient({ transport: http(rpc) });
for (let i = 0; ; i++) {
  try {
    if ((await pc.getChainId()) === CHAIN) break;
  } catch {
    /* not up yet */
  }
  if (i > 100) {
    console.error("anvil did not start");
    shutdown(1);
  }
  await new Promise((r) => setTimeout(r, 100));
}

function run(env: Record<string, string>, ...args: string[]) {
  const r = spawnSync(
    process.execPath,
    [join(root, "node_modules/tsx/dist/cli.mjs"), "scripts/deploy-remote.ts", ...args],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        OSTRAKON_DEPLOY_RPC: "",
        OSTRAKON_DEPLOY_KEY: "",
        OSTRAKON_PUBLIC_RPC: "",
        OSTRAKON_PUBLIC_WS: "",
        OSTRAKON_CHAIN_NAME: "",
        ...env,
      },
    },
  );
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const fresh = generatePrivateKey();
const freshAddr = privateKeyToAccount(fresh).address;

// Empty strings stand for "unset", so variables from the outer shell can't leak in.
let r = run({});
check(r.code === 1 && r.out.includes("OSTRAKON_DEPLOY_RPC"), "no RPC: refused", r.out);

r = run({ OSTRAKON_DEPLOY_RPC: rpc, OSTRAKON_DEPLOY_KEY: "0x1234" });
check(r.code === 1 && r.out.includes("32-byte private key"), "malformed key: refused", r.out);

// Above the curve order: the crypto library's own error would print the key as a number.
const badKey = `0x${"f".repeat(64)}`;
r = run({ OSTRAKON_DEPLOY_RPC: rpc, OSTRAKON_DEPLOY_KEY: badKey });
check(
  r.code === 1 && r.out.includes("not a valid secp256k1") && !r.out.includes("ffffffff") && !/\n\s+at /.test(r.out),
  "out-of-range key: refused without echoing it or a stack trace",
  r.out,
);

// An RPC that answers eth_chainId and fails everything else: viem's error names the request URL.
const broken = createServer((req, res) => {
  let body = "";
  req.on("data", (c: Buffer) => (body += c.toString()));
  req.on("end", () => {
    const { id, method } = JSON.parse(body) as { id: number; method: string };
    const reply =
      method === "eth_chainId"
        ? { jsonrpc: "2.0", id, result: toHex(CHAIN) }
        : { jsonrpc: "2.0", id, error: { code: -32000, message: "upstream unavailable" } };
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(reply));
  });
});
await new Promise<void>((ok) => broken.listen(PORT + 1, "127.0.0.1", ok));
r = run({
  OSTRAKON_DEPLOY_RPC: `http://127.0.0.1:${PORT + 1}/?apikey=do-not-leak`,
  OSTRAKON_DEPLOY_KEY: generatePrivateKey(),
  OSTRAKON_PUBLIC_RPC: publicRpc,
});
broken.close();
check(
  r.code === 1 && !r.out.includes("do-not-leak") && !/\n\s+at /.test(r.out),
  "RPC failure mid-run: reported without the deploy RPC's API key or a stack trace",
  r.out,
);

r = run({ OSTRAKON_DEPLOY_RPC: rpc, OSTRAKON_DEPLOY_KEY: anvilKey0, OSTRAKON_PUBLIC_RPC: publicRpc });
check(r.code === 1 && r.out.includes("Anvil test key"), "Anvil test key on a non-local chain: refused", r.out);

r = run({ OSTRAKON_DEPLOY_RPC: secretRpc, OSTRAKON_DEPLOY_KEY: fresh });
check(r.code === 1 && r.out.includes("OSTRAKON_PUBLIC_RPC"), "no public RPC on a non-local chain: refused", r.out);

r = run({ OSTRAKON_DEPLOY_RPC: secretRpc, OSTRAKON_DEPLOY_KEY: fresh, OSTRAKON_PUBLIC_RPC: publicRpc });
check(r.code === 1 && r.out.includes("balance doesn't cover"), "unfunded deployer: refused", r.out);

await pc.request({ method: "anvil_setBalance" as never, params: [freshAddr, toHex(10n ** 18n)] as never });
const out = join(tmp, "deployment.json");
const env = {
  OSTRAKON_DEPLOY_RPC: secretRpc,
  OSTRAKON_DEPLOY_KEY: fresh,
  OSTRAKON_PUBLIC_RPC: publicRpc,
  OSTRAKON_CHAIN_NAME: "Test net",
};

r = run(env, "--out", out);
const nonceAfterDry = await pc.getTransactionCount({ address: freshAddr });
check(
  r.code === 0 && r.out.includes("Dry run") && nonceAfterDry === 0 && !existsSync(out),
  "dry run: estimates, sends nothing, writes nothing",
  r.out,
);

r = run(env, "--yes", "--out", out);
check(r.code === 0 && existsSync(out), "--yes: deploys and writes the record", r.out);
const raw = readFileSync(out, "utf8");
const d = parseDeployment(JSON.parse(raw));
check(d !== null, "record matches the app's deployment schema", raw);
check(d!.chainId === CHAIN && d!.chainName === "Test net", "record names the chain");
check(d!.rpcUrl === publicRpc, "record carries the public RPC, not the deploy RPC");
check(!raw.includes("do-not-leak") && !r.out.includes("do-not-leak"), "the deploy RPC's API key appears nowhere");
check(!r.out.includes(fresh.slice(2)) && !raw.includes(fresh.slice(2)), "the private key appears nowhere");
const code = await pc.getCode({ address: d!.address });
check(!!code && code.length > 2, "contract code exists at the recorded address");
const receipt = await pc.getTransactionReceipt({ hash: d!.deployTx });
check(receipt.contractAddress?.toLowerCase() === d!.address.toLowerCase(), "deployTx created that address");
check(receipt.blockNumber.toString() === d!.deployBlock, "deployBlock matches the receipt");

console.log(`\n${passed} checks passed`);
shutdown(0);
