import { useRuntime } from "../chain/runtime";
import type { TxState } from "../chain/tx";
import { Hex } from "./Copy";

const STEPS = ["Check", "Sign", "Pending", "Confirmed"] as const;

function stepIndex(s: TxState): number {
  switch (s.status) {
    case "simulating":
      return 0;
    case "awaiting-signature":
      return 1;
    case "pending":
      return 2;
    case "confirmed":
      return 3;
    default:
      return -1;
  }
}

/** Live, announced transaction progress. Renders only curated text (errors come from decodeError). */
export function TxStatus({ state, onDismiss, idleHint }: { state: TxState; onDismiss?: () => void; idleHint?: string }) {
  const { health } = useRuntime();
  const idx = stepIndex(state);
  let line: string;
  switch (state.status) {
    case "idle":
      line = idleHint ?? "";
      break;
    case "simulating":
      line = "Checking the transaction against the chain…";
      break;
    case "awaiting-signature":
      line = "Waiting for your signature in the wallet.";
      break;
    case "pending":
      line = "Sent. Waiting for it to be included in a block.";
      break;
    case "confirmed": {
      const conf = health.block !== null ? Number(health.block - state.blockNumber) + 1 : 1;
      line = `Confirmed in block ${state.blockNumber.toString()} · ${conf} confirmation${conf === 1 ? "" : "s"}.`;
      break;
    }
    case "failed":
      line = state.error.message;
      break;
  }
  return (
    <div className={`tx tx-${state.status}`} data-testid="tx-status">
      {state.status !== "idle" && state.status !== "failed" && (
        <ol className="tx-steps" aria-hidden="true">
          {STEPS.map((s, i) => (
            <li key={s} className={i < idx ? "done" : i === idx ? "now" : ""}>
              {s}
            </li>
          ))}
        </ol>
      )}
      <p className="tx-line" role="status" aria-live="polite">
        {line}
      </p>
      {"hash" in state && state.hash && (
        <p className="tx-hash">
          tx <Hex value={state.hash} label="transaction hash" head={10} tail={8} />
        </p>
      )}
      {(state.status === "failed" || state.status === "confirmed") && onDismiss && (
        <button type="button" className="btn-link" onClick={onDismiss}>
          Dismiss
        </button>
      )}
    </div>
  );
}
