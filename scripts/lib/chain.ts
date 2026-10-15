import { spawn, type ChildProcess } from "node:child_process";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type Address,
  type Hash,
  type PublicClient,
} from "viem";
import { mnemonicToAccount, type HDAccount } from "viem/accounts";
import { ostrakonAbi } from "../../web/src/generated/ostrakonAbi.ts";
import { ostrakonBytecode } from "../../web/src/generated/ostrakonBytecode.ts";
import type { Deployment } from "../../web/src/chain/deployment.ts";
import { foundryBin } from "./foundry.ts";

/** Anvil's default, publicly known test mnemonic. Never use these keys on a real network. */
export const TEST_MNEMONIC = "test test test test test test test test test test test junk";
export const CHAIN_ID = 31337;
export const PORT = Number(process.env.OSTRAKON_RPC_PORT ?? 8545);
export const RPC_URL = `http://127.0.0.1:${PORT}`;
export const WS_URL = `ws://127.0.0.1:${PORT}`;

export const localChain = defineChain({
  id: CHAIN_ID,
  name: "Anvil (local)",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL], webSocket: [WS_URL] } },
});

export function account(i: number): HDAccount {
  return mnemonicToAccount(TEST_MNEMONIC, { addressIndex: i });
}

export function publicClient(): PublicClient {
  return createPublicClient({ chain: localChain, transport: http(RPC_URL) }) as PublicClient;
}

export function walletFor(i: number) {
  return createWalletClient({ account: account(i), chain: localChain, transport: http(RPC_URL) });
}

export async function rpcAlive(): Promise<number | null> {
  try {
    const res = await fetch(RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
    });
    const j = (await res.json()) as { result?: string };
    return j.result ? Number(j.result) : null;
  } catch {
    return null;
  }
}

export async function startAnvil(): Promise<ChildProcess> {
  const child = spawn(foundryBin("anvil"), ["--port", String(PORT), "--chain-id", String(CHAIN_ID), "--silent"], {
    stdio: ["ignore", "inherit", "inherit"],
  });
  for (let i = 0; i < 100; i++) {
    if ((await rpcAlive()) === CHAIN_ID) return child;
    if (child.exitCode !== null) throw new Error(`anvil exited with code ${child.exitCode}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill();
  throw new Error("anvil did not start within 10s");
}

/** Switch anvil from instant automine to fixed block time so confirmations visibly tick. */
export async function setIntervalMining(seconds: number): Promise<void> {
  await publicClient().request({ method: "evm_setIntervalMining" as never, params: [seconds] as never });
}

export async function deploy(): Promise<Deployment> {
  const pc = publicClient();
  const wallet = walletFor(0);
  const hash = await wallet.deployContract({ abi: ostrakonAbi, bytecode: ostrakonBytecode });
  const receipt = await pc.waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress) throw new Error("deploy: no contract address in receipt");
  return {
    chainId: CHAIN_ID,
    chainName: localChain.name,
    rpcUrl: RPC_URL,
    wsUrl: WS_URL,
    address: receipt.contractAddress,
    deployBlock: receipt.blockNumber.toString(),
    deployTx: hash,
    deployedAt: new Date().toISOString(),
  };
}

type Write = Parameters<ReturnType<typeof walletFor>["writeContract"]>[0];

/** Send a write from anvil account `from`, simulate first, wait for the receipt. */
export async function send(
  address: Address,
  from: number,
  functionName: Write["functionName"],
  args: readonly unknown[],
): Promise<Hash> {
  const pc = publicClient();
  const { request } = await pc.simulateContract({
    address,
    abi: ostrakonAbi,
    functionName: functionName as never,
    args: args as never,
    account: account(from),
  });
  const hash = await walletFor(from).writeContract(request as never);
  const receipt = await pc.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${String(functionName)} reverted`);
  return hash;
}
