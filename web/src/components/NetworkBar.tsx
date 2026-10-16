import { useId, useState } from "react";
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
            {runtime.chain.name} <span className="mono muted netbar-chainid">{runtime.chain.id}</span>
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
      return wallet.wallets.length > 1 ? (
        <WalletChooser />
      ) : (
        <button type="button" className="btn btn-solid" onClick={() => void wallet.connect()}>
          Connect wallet
        </button>
      );
  }
}

/** Several wallets announced themselves (EIP-6963): let the user pick which one to use. */
function WalletChooser() {
  const wallet = useWallet();
  const [open, setOpen] = useState(false);
  const menuId = useId();
  return (
    <div className="chooser">
      <button
        type="button"
        className="btn btn-solid"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(ev) => {
          if (ev.key === "Escape") setOpen(false);
        }}
      >
        Connect wallet
      </button>
      {open && (
        <ul id={menuId} className="chooser-menu" aria-label="Choose a wallet">
          {wallet.wallets.map((w) => (
            <li key={w.id}>
              <button
                type="button"
                className="btn btn-quiet"
                onClick={() => {
                  setOpen(false);
                  void wallet.connect(w.id);
                }}
              >
                {w.name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
