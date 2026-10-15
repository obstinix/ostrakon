import { useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import { getAddress, isAddress, zeroAddress, zeroHash, type Hex } from "viem";
import { useAccount, useElection, useVoters } from "../chain/hooks";
import { phasesFor, phaseStep, type ElectionDetail } from "../chain/reads";
import { useRuntime } from "../chain/runtime";
import { isBusy, useTx } from "../chain/tx";
import { Hex as HexText } from "../components/Copy";
import { Pending } from "../components/Pending";
import { PhaseMark } from "../components/PhaseMark";
import { TxStatus } from "../components/TxStatus";
import { fmtTime, plural, sameAddr } from "../lib/format";
import { useNow } from "../lib/useNow";
import { chunk, previewVoters } from "../lib/voters";
import { parseId } from "./Election";

const MAX_BATCH = 200;

export function ManagePage() {
  const id = parseId(useParams().id);
  const election = useElection(id);
  const account = useAccount();

  if (id === null || election.isError) {
    return (
      <section className="page">
        <h1>No such election</h1>
        <Link to="/">Back to the ledger</Link>
      </section>
    );
  }
  if (election.isPending) return <Pending what="election" />;
  const e = election.data;

  if (!sameAddr(e.admin, account)) {
    return (
      <section className="page narrow" aria-labelledby="m-title">
        <p className="eyebrow">Election No. {e.id.toString()}</p>
        <h1 id="m-title">Admin only</h1>
        <p>
          Only this election's admin can manage it. The admin is <HexText value={e.admin} label="admin address" />.
          {account ? " Your connected account is not the admin." : " Connect the admin's wallet to continue."}
        </p>
        <Link to={`/e/${e.id.toString()}`}>Back to the election</Link>
      </section>
    );
  }

  return (
    <section className="page" aria-labelledby="m-title">
      <header className="page-head">
        <p className="eyebrow">
          Manage · <Link to={`/e/${e.id.toString()}`}>Election No. {e.id.toString()}</Link>
        </p>
        <h1 id="m-title">{e.name}</h1>
        <div className="el-meta">
          <PhaseMark phase={e.phase} secret={e.secret} finalized={e.finalized} />
          <span className="small">
            {plural(e.voterCount, "registered voter")} · {plural(e.totalVotes, "vote")}
          </span>
        </div>
      </header>
      <div className="manage-grid">
        <PhaseControl e={e} />
        <RegisterVoters e={e} />
        <Allowlist e={e} />
        <VoterList e={e} />
        <TransferAdmin e={e} />
      </div>
    </section>
  );
}

function PhaseControl({ e }: { e: ElectionDetail }) {
  const tx = useTx();
  const nowSec = BigInt(Math.floor(useNow() / 1000));
  let action: { label: string; blockedBy?: string } | null = null;
  if (e.phase === "Registration") {
    action = {
      label: "Open voting",
      blockedBy: e.votingStart && e.votingStart > nowSec ? `Scheduled to open at ${fmtTime(e.votingStart)}.` : undefined,
    };
  } else if (e.phase === "Voting") {
    action = {
      label: e.secret ? "Close voting, open reveal" : "Close voting",
      blockedBy: e.votingEnd && e.votingEnd > nowSec ? `Scheduled to close at ${fmtTime(e.votingEnd)}.` : undefined,
    };
  } else if (e.phase === "Reveal") {
    action = {
      label: "Close reveal",
      blockedBy:
        e.revealEnd && e.revealEnd > nowSec ? `Reveal is scheduled to close at ${fmtTime(e.revealEnd)}.` : undefined,
    };
  }
  const list = phasesFor(e);
  const step = phaseStep(e);
  return (
    <section className="panel" aria-labelledby="pc-title">
      <h2 id="pc-title">Phase</h2>
      <ol className="phase-steps">
        {list.map((p, i) => (
          <li key={p} className={i < step ? "done" : i === step ? "now" : ""}>
            {p}
          </li>
        ))}
      </ol>
      <p className="muted small">Phases only move forward. Registration closes for good when voting opens.</p>
      {action && (
        <>
          <button
            type="button"
            className="btn btn-solid"
            disabled={!!action.blockedBy || isBusy(tx.state)}
            onClick={() => void tx.run({ functionName: "advancePhase", args: [e.id] })}
          >
            {action.label}
          </button>
          {action.blockedBy && <p className="small">{action.blockedBy}</p>}
        </>
      )}
      {e.phase === "Ended" && !e.finalized && (
        <button
          type="button"
          className="btn btn-solid"
          disabled={isBusy(tx.state)}
          onClick={() => void tx.run({ functionName: "finalize", args: [e.id] })}
        >
          Finalize result
        </button>
      )}
      {e.finalized && <p>The result is final.</p>}
      <TxStatus state={tx.state} onDismiss={tx.reset} />
    </section>
  );
}

function RegisterVoters({ e }: { e: ElectionDetail }) {
  const voters = useVoters(e.id);
  const tx = useTx();
  const [raw, setRaw] = useState("");
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const registered = useMemo(() => new Set((voters.data ?? []).map((v) => v.toLowerCase())), [voters.data]);
  const preview = useMemo(() => previewVoters(raw, registered), [raw, registered]);
  const batches = chunk(preview.add, MAX_BATCH);

  if (e.phase !== "Registration") {
    return (
      <section className="panel" aria-labelledby="rv-title">
        <h2 id="rv-title">Register voters</h2>
        <p className="muted">Registration is closed: the election is in {e.phase}.</p>
      </section>
    );
  }

  const send = async () => {
    setProgress({ done: 0, total: batches.length });
    for (let i = 0; i < batches.length; i++) {
      const ok = await tx.run({ functionName: "registerVoters", args: [e.id, batches[i]!] });
      if (!ok) return;
      setProgress({ done: i + 1, total: batches.length });
    }
    setRaw("");
  };

  return (
    <section className="panel panel-wide" aria-labelledby="rv-title">
      <h2 id="rv-title">Register voters</h2>
      <label className="field">
        <span>Paste addresses (one per line, or separated by commas or spaces)</span>
        <textarea value={raw} onChange={(ev) => setRaw(ev.target.value)} rows={6} spellCheck={false} className="mono" />
      </label>
      {raw.trim() && (
        <div className="preview" aria-live="polite" data-testid="voter-preview">
          <dl className="kv kv-row">
            <div>
              <dt>Will register</dt>
              <dd className="mono">{preview.add.length}</dd>
            </div>
            <div>
              <dt>Already registered</dt>
              <dd className="mono">{preview.already.length}</dd>
            </div>
            <div>
              <dt>Repeated in list</dt>
              <dd className="mono">{preview.duplicates.length}</dd>
            </div>
            <div>
              <dt>Invalid</dt>
              <dd className="mono">{preview.invalid.length + preview.zero}</dd>
            </div>
          </dl>
          {preview.invalid.length > 0 && (
            <ul className="problems">
              {preview.invalid.slice(0, 6).map((x, i) => (
                <li key={i}>
                  <code>{x.line}</code>{" "}
                  {x.reason === "checksum" ? "has a bad checksum (check for a typo)" : "isn't an address"}
                </li>
              ))}
              {preview.invalid.length > 6 && <li>…and {preview.invalid.length - 6} more</li>}
            </ul>
          )}
          {preview.zero > 0 && <p className="small">The zero address is skipped.</p>}
          {batches.length > 1 && (
            <p className="small">
              Sent as {batches.length} transactions of up to {MAX_BATCH} addresses each.
            </p>
          )}
        </div>
      )}
      <button
        type="button"
        className="btn btn-solid"
        disabled={preview.add.length === 0 || isBusy(tx.state)}
        onClick={() => void send()}
      >
        Register {plural(preview.add.length, "voter")}
      </button>
      {progress && progress.total > 1 && (
        <p className="small mono">
          batch {progress.done}/{progress.total}
        </p>
      )}
      <TxStatus state={tx.state} onDismiss={tx.reset} />
    </section>
  );
}

function VoterList({ e }: { e: ElectionDetail }) {
  const voters = useVoters(e.id);
  const [shown, setShown] = useState(20);
  const list = voters.data ?? [];
  return (
    <section className="panel" aria-labelledby="vl-title">
      <h2 id="vl-title">Voter list</h2>
      <p className="muted small">Public by design: anyone can read this list from the contract or its events.</p>
      {list.length === 0 ? (
        <p className="muted">No voters registered yet.</p>
      ) : (
        <ol className="voter-list">
          {list.slice(0, shown).map((v) => (
            <li key={v}>
              <HexText value={v} label="voter address" />
            </li>
          ))}
        </ol>
      )}
      {list.length > shown && (
        <button type="button" className="btn-link" onClick={() => setShown((n) => n + 50)}>
          Show more ({list.length - shown} left)
        </button>
      )}
    </section>
  );
}

function TransferAdmin({ e }: { e: ElectionDetail }) {
  const tx = useTx();
  const [to, setTo] = useState("");
  const trimmed = to.trim();
  const valid = isAddress(trimmed) && !/^0x0{40}$/i.test(trimmed) && !sameAddr(trimmed, e.admin);
  const pending = e.pendingAdmin !== zeroAddress;
  return (
    <section className="panel" aria-labelledby="ta-title" data-testid="transfer-admin">
      <h2 id="ta-title">Hand over admin</h2>
      <p className="small">
        Two steps: you nominate an address, then that address accepts from its own wallet. You stay admin until it
        does, so a mistyped address can't take or strand the election.
      </p>
      {pending && (
        <div className="pending-admin">
          <p className="small">
            Waiting for <HexText value={e.pendingAdmin} label="nominated admin" /> to accept.
          </p>
          <button
            type="button"
            className="btn btn-quiet"
            disabled={isBusy(tx.state)}
            onClick={() => void tx.run({ functionName: "cancelAdminTransfer", args: [e.id] })}
          >
            Cancel nomination
          </button>
        </div>
      )}
      <label className="field">
        <span>{pending ? "Nominate someone else instead" : "Nominate a new admin"}</span>
        <input className="mono" value={to} onChange={(ev) => setTo(ev.target.value)} spellCheck={false} />
      </label>
      {trimmed && !valid && (
        <p className="inline-error">
          {sameAddr(trimmed, e.admin)
            ? "That's already the admin."
            : "That isn't a valid, non-zero address. Mixed-case input must match its checksum."}
        </p>
      )}
      <button
        type="button"
        className="btn btn-quiet"
        disabled={!valid || isBusy(tx.state)}
        onClick={() => void tx.run({ functionName: "transferAdmin", args: [e.id, getAddress(trimmed)] })}
      >
        Nominate
      </button>
      <TxStatus state={tx.state} onDismiss={tx.reset} />
    </section>
  );
}

/** Publish a Merkle-root allowlist (Registration only): build the tree locally, publish the root,
 *  and hand the admin the tree file to distribute. */
function Allowlist({ e }: { e: ElectionDetail }) {
  const { runtime } = useRuntime();
  const tx = useTx();
  const [raw, setRaw] = useState("");
  const [uri, setUri] = useState("");
  const [built, setBuilt] = useState<{ root: Hex; size: number; json: string } | null>(null);
  const preview = useMemo(() => previewVoters(raw, new Set()), [raw]);
  const uriBytes = new TextEncoder().encode(uri.trim()).length;
  const hasRoot = e.allowlistRoot !== zeroHash;

  const build = async () => {
    const { buildAllowlist } = await import("../lib/allowlist");
    setBuilt(buildAllowlist(preview.add));
  };
  const publish = async () => {
    if (!built) return;
    const receipt = await tx.run({ functionName: "setAllowlist", args: [e.id, built.root, uri.trim()] });
    if (receipt) {
      const { saveTree } = await import("../lib/allowlist");
      saveTree(runtime.chain.id, runtime.deployment.address, e.id, built.json);
    }
  };

  return (
    <section className="panel panel-wide" aria-labelledby="al-title" data-testid="allowlist-admin">
      <h2 id="al-title">Allowlist (large electorates)</h2>
      <p className="small">
        Instead of registering every address, publish one fingerprint (a Merkle root) of the whole list. Listed voters
        register themselves with a proof when they vote, paying their own gas. The list is frozen when voting opens.
        Direct registration keeps working alongside it.
      </p>
      {hasRoot && (
        <p className="small">
          Current root: <HexText value={e.allowlistRoot} label="allowlist root" />. Publishing again replaces it.
        </p>
      )}
      {e.phase !== "Registration" ? (
        <p className="muted">The allowlist can only change during Registration.</p>
      ) : (
        <>
          <label className="field">
            <span>Eligible addresses (one per line, or separated by commas or spaces)</span>
            <textarea
              value={raw}
              onChange={(ev) => {
                setRaw(ev.target.value);
                setBuilt(null);
              }}
              rows={5}
              spellCheck={false}
              className="mono"
            />
          </label>
          {raw.trim() && (
            <p className="small mono" aria-live="polite">
              {preview.add.length} valid · {preview.duplicates.length} repeated · {preview.invalid.length + preview.zero}{" "}
              invalid
            </p>
          )}
          <label className="field">
            <span>Where you'll publish the list (optional link, shown to voters)</span>
            <input value={uri} onChange={(ev) => setUri(ev.target.value)} placeholder="https://…/allowlist.json" />
            <small className="mono">{uriBytes}/256 bytes</small>
          </label>
          <div className="btn-row">
            <button
              type="button"
              className="btn btn-quiet"
              disabled={preview.add.length === 0 || preview.invalid.length > 0}
              onClick={() => void build()}
            >
              Build list
            </button>
            {built && (
              <>
                <button
                  type="button"
                  className="btn btn-solid"
                  disabled={uriBytes > 256 || isBusy(tx.state)}
                  onClick={() => void publish()}
                >
                  Publish root for {built.size} addresses
                </button>
                <button
                  type="button"
                  className="btn btn-quiet"
                  onClick={() => void import("../lib/allowlist").then((m) => m.downloadTree(e.id, built.json))}
                >
                  Download list file
                </button>
              </>
            )}
          </div>
          {preview.invalid.length > 0 && <p className="inline-error">Fix the invalid entries before building.</p>}
          {built && (
            <p className="small">
              Root <HexText value={built.root} label="new allowlist root" />. Publish the list file at the link above (or
              send it to voters): they need it to prove they're on the list.
            </p>
          )}
          <TxStatus state={tx.state} onDismiss={tx.reset} />
        </>
      )}
    </section>
  );
}
