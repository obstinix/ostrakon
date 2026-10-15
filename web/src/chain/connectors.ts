import type { CreateConnectorFn } from "wagmi";
import { injected } from "wagmi/connectors";

/**
 * Wallet connectors. Production: the browser's injected wallet (MetaMask, Rabby, ...) only.
 * `VITE_E2E` is replaced at build time; in a normal build the branch is constant-false and the
 * test connector chunk is never emitted.
 */
export async function loadConnectors(): Promise<CreateConnectorFn[]> {
  const list: CreateConnectorFn[] = [injected({ shimDisconnect: true })];
  if (import.meta.env.VITE_E2E === "1") {
    const { testConnector } = await import("./testConnector");
    list.unshift(testConnector());
  }
  return list;
}
