import { useRuntime } from "../chain/runtime";
import { useWallet } from "../chain/wallet";
import { short } from "../lib/format";

/**
 * Explains every condition that would otherwise look like a blank or broken page:
 * chain unreachable, contract missing at the saved address, no/locked wallet, wrong chain,
 * and the last wallet error (already curated by decodeError).
 */
export function HealthNotice() {
  const { runtime, health } = useRuntime();
  const wallet = useWallet();
  const notices: { tone: "error" | "warn" | "info"; title: string; body: React.ReactNode; id: string }[] = [];

  if (health.rpc === "down") {
    notices.push({
      id: "rpc-down",
      tone: "error",
      title: "Can't reach the chain",
      body: (
        <>
          Nothing is answering at <code>{runtime.deployment.rpcUrl}</code>. If you are running locally, start it again
          with <code>npm run dev</code>. This page reconnects by itself.
        </>
      ),
    });
  } else if (health.rpc === "up" && health.code === "missing") {
    notices.push({
      id: "stale",
      tone: "error",
      title: "The contract isn't at the saved address",
      body: (
        <>
          The chain is up, but there's no contract code at <code>{short(runtime.deployment.address, 10, 6)}</code>.
          This usually means the local chain restarted and lost its state since the app was deployed. Stop the dev
          command and run <code>npm run dev</code> again to redeploy, then reload.
        </>
      ),
    });
  }

  switch (wallet.state.kind) {
    case "no-wallet":
      notices.push({
        id: "no-wallet",
        tone: "info",
        title: "Read-only mode",
        body: (
          <>
            No browser wallet was found. You can read every election, tally and audit record. To vote or run an
            election, install a wallet such as MetaMask and reload.
          </>
        ),
      });
      break;
    case "locked":
      notices.push({
        id: "locked",
        tone: "warn",
        title: "Your wallet is locked",
        body: <>Unlock it, then choose Connect wallet. Everything stays readable meanwhile.</>,
      });
      break;
    case "wrong-chain":
      notices.push({
        id: "wrong-chain",
        tone: "warn",
        title: "Wallet is on a different network",
        body: (
          <>
            Your wallet is on chain <span className="mono">{wallet.state.chainId}</span>; Ostrakon is on{" "}
            {runtime.chain.name} (<span className="mono">{runtime.chain.id}</span>).{" "}
            <button type="button" className="btn-link" onClick={() => void wallet.switchChain()}>
              Switch (or add) the network
            </button>
            .
          </>
        ),
      });
      break;
  }

  if (wallet.error) {
    notices.push({ id: "wallet-error", tone: "warn", title: "Wallet", body: wallet.error.message });
  }

  if (notices.length === 0) return null;
  return (
    <div className="notices" aria-live="polite">
      {notices.map((n) => (
        <section key={n.id} className={`notice notice-${n.tone}`} data-testid={`notice-${n.id}`}>
          <h2>{n.title}</h2>
          <p>{n.body}</p>
        </section>
      ))}
    </div>
  );
}
