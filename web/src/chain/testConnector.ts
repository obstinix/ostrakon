// TEST ONLY. Loaded via dynamic import when the app is built with VITE_E2E=1 (see connectors.ts).
// Production builds never include this module; docs/VERIFICATION.md shows the grep proving it.
// It wraps wagmi's mock connector: account/chain requests are answered locally and everything
// else (eth_sendTransaction, eth_call, ...) is forwarded to the local anvil node, whose default
// accounts are unlocked, so transactions are real.
import type { Address } from "viem";
import { mock } from "wagmi/connectors/mock";

const ANVIL_ACCOUNTS: readonly Address[] = [
  "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
  "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
  "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65",
  "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc",
  "0x976EA74026E726554dB657fA54763abd0C3a0aa9",
  "0x14dC79964da2C08b23698B3D3cc7Ca32193d9955",
];

declare global {
  interface Window {
    /** Set by Playwright via addInitScript. `mock: false` leaves only the injected connector. */
    __OSTRAKON_E2E__?: { account?: number; connectError?: boolean; mock?: boolean; signError?: boolean };
  }
}

export function testConnectorEnabled(): boolean {
  return window.__OSTRAKON_E2E__?.mock !== false;
}

export function testConnector() {
  const opts = window.__OSTRAKON_E2E__ ?? {};
  const idx = Math.min(Math.max(opts.account ?? 0, 0), ANVIL_ACCOUNTS.length - 1);
  return mock({
    accounts: [ANVIL_ACCOUNTS[idx]!],
    features: { connectError: opts.connectError ?? false, signMessageError: opts.signError ?? false, reconnect: true },
  });
}
