import { useElections, useMyStatuses } from "../chain/hooks";
import { useRuntime } from "../chain/runtime";
import { useWallet } from "../chain/wallet";
import { sameAddr } from "../lib/format";
import { Hex } from "./Copy";

function useRoleSummary(address: `0x${string}` | undefined): string {
  const elections = useElections();
  const statuses = useMyStatuses(address);
  if (!address) return "Read-only";
  const adminOf = elections.data?.filter((e) => sameAddr(e.admin, address)).length ?? 0;
  const voterIn = statuses.data ? [...statuses.data.values()].filter((s) => s.registered).length : 0;
  const parts = [adminOf ? `Admin ×${adminOf}` : "", voterIn ? `Voter ×${voterIn}` : ""].filter(Boolean);
  return parts.length ? parts.join(" · ") : "No role";
}

/** Persistent bar: chain, live block, account, role, contract, and the connect control. */
export function NetworkBar() {
  const { runtime, health } = useRuntime();
  const wallet = useWallet();
  const address =
    wallet.state.kind === "connected" || wallet.state.kind === "wrong-chain" ? wallet.state.address : undefined;
  const role = useRoleSummary(wallet.state.kind === "connected" ? address : undefined);
  const live = health.rpc === "up";

  return (
    <div className="netbar" role="region" aria-label="Network status">
      <dl className="netbar-items">
        <div>
          <dt>Chain</dt>
          <dd>
            <span className={`dot ${live ? "dot-live" : "dot-down"}`} aria-hidden="true" />
            {runtime.chain.name} <span className="mono muted">{runtime.chain.id}</span>
          </dd>
        </div>
        <div>
          <dt>Block</dt>
          <dd className="mono" data-testid="block-number">
            {health.block !== null ? `#${health.block.toString()}` : "-"}
          </dd>
        </div>
        <div>
          <dt>Account</dt>
          <dd>{address ? <Hex value={address} label="account address" /> : <span className="muted">none</span>}</dd>
        </div>
        <div>
          <dt>Role</dt>
          <dd data-testid="role">{role}</dd>
        </div>
        <div className="netbar-contract">
          <dt>Contract</dt>
          <dd>
            <Hex value={runtime.deployment.address} label="contract address" />
          </dd>
        </div>
      </dl>
      <ConnectControl />
    </div>
  );
}

function ConnectControl() {
  const wallet = useWallet();
  const s = wallet.state;
  switch (s.kind) {
    case "connected":
      return (
        <button type="button" className="btn btn-quiet" onClick={wallet.disconnect}>
          Disconnect
        </button>
      );
    case "wrong-chain":
      return (
        <button type="button" className="btn btn-solid" onClick={() => void wallet.switchChain()}>
          Switch network
        </button>
      );
    case "connecting":
      return (
        <button type="button" className="btn btn-quiet" disabled>
          Connecting…
        </button>
      );
    case "no-wallet":
      return <span className="netbar-note">No wallet · read-only</span>;
    default:
      return (
        <button type="button" className="btn btn-solid" onClick={() => void wallet.connect()}>
          Connect wallet
        </button>
      );
  }
}
