import { useId, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { useAccount, useAuditLog, useElection, useVoterStatus } from "../chain/hooks";
import { leaders, PHASES, share, type AuditEntry, type ElectionDetail, type VoterStatus } from "../chain/reads";
import { isBusy, useTx } from "../chain/tx";
import { useWallet } from "../chain/wallet";
import { Hex } from "../components/Copy";
import { CountUp, FillBar, useReducedMotion, useScrollProgress, useTilt } from "../components/motion";
import { PhaseMark } from "../components/PhaseMark";
import { TxStatus } from "../components/TxStatus";
import { fmtTime, pct, plural, sameAddr } from "../lib/format";

export function parseId(raw: string | undefined): bigint | null {
  return raw && /^\d{1,9}$/.test(raw) && raw !== "0" ? BigInt(raw) : null;
}

export function ElectionPage() {
  const id = parseId(useParams().id);
  const election = useElection(id);
  const account = useAccount();
  const status = useVoterStatus(id, account);

  if (id === null) return <NotFound />;
  if (election.isPending) return <section className="page"><p className="muted">Reading election…</p></section>;
  if (election.isError) return <NotFound />;
  const e = election.data;
  const isAdmin = sameAddr(e.admin, account);

  return (
    <article className="page election" aria-labelledby="el-title">
      <header className="page-head">
        <p className="eyebrow">Election № {e.id.toString()}</p>
        <h1 id="el-title">{e.name}</h1>
        <div className="el-meta">
          <PhaseMark phase={e.phase} index={e.phaseIndex} finalized={e.finalized} />
          <span>
            Admin <Hex value={e.admin} label="admin address" />
          </span>
          <span className="mono small">created block {e.createdBlock.toString()}</span>
          {isAdmin && (
            <Link className="btn btn-quiet" to={`/e/${e.id.toString()}/manage`}>
              Manage election
            </Link>
          )}
        </div>
        <Schedule e={e} />
      </header>

      <div className="el-grid">
        <section aria-labelledby="cand-title" className="el-candidates">
          <div className="section-head">
            <h2 id="cand-title">Candidates</h2>
            <p className="muted small">
              {plural(e.totalVotes, "vote")} of {plural(e.voterCount, "registered voter")}
            </p>
          </div>
          <Ballot e={e} status={status.data} account={account} />
        </section>
        <aside className="el-side" aria-label="Your status and result">
          <Eligibility e={e} status={status.data} account={account} />
          <Result e={e} />
        </aside>
      </div>

      <Lifecycle e={e} />
    </article>
  );
}

function NotFound() {
  return (
    <section className="page">
      <h1>No such election</h1>
      <p>
        This contract has no election with that number. <Link to="/">Back to the ledger</Link>.
      </p>
    </section>
  );
}

function Schedule({ e }: { e: ElectionDetail }) {
  if (e.votingStart === 0n && e.votingEnd === 0n) {
    return <p className="muted small">No schedule: the admin moves the election from phase to phase.</p>;
  }
  return (
    <p className="small">
      Scheduled window: {e.votingStart ? <strong>{fmtTime(e.votingStart)}</strong> : "opens when the admin advances"} →{" "}
      {e.votingEnd ? <strong>{fmtTime(e.votingEnd)}</strong> : "closes when the admin advances"}. The contract enforces
      these times; the admin can't move them.
    </p>
  );
}

// ------------------------------------------------------------------ ballot

function Ballot({ e, status, account }: { e: ElectionDetail; status?: VoterStatus; account?: `0x${string}` }) {
  const tx = useTx();
  const [open, setOpen] = useState<number | null>(null);
  const canVote = e.phaseIndex === 1 && !!account && !!status?.registered && !status.voted;
  const lead = e.totalVotes > 0 ? leaders(e.tallies) : [];

  return (
    <>
      <ul className="cards" role="list">
        {e.candidates.map((name, i) => (
          <li key={i}>
            <CandidateCard
              index={i}
              name={name}
              tally={e.tallies[i] ?? 0}
              total={e.totalVotes}
              leading={lead.includes(i)}
              winner={e.finalized && !e.tie && e.winner === i}
              open={open === i}
              onToggle={() => setOpen(open === i ? null : i)}
              canVote={canVote}
              busy={isBusy(tx.state)}
              onVote={() => void tx.run({ functionName: "vote", args: [e.id, BigInt(i)] })}
            />
          </li>
        ))}
      </ul>
      <TxStatus state={tx.state} onDismiss={tx.reset} />
    </>
  );
}

function CandidateCard(p: {
  index: number;
  name: string;
  tally: number;
  total: number;
  leading: boolean;
  winner: boolean;
  open: boolean;
  onToggle: () => void;
  canVote: boolean;
  busy: boolean;
  onVote: () => void;
}) {
  const tilt = useTilt<HTMLDivElement>(3);
  const panel = useId();
  const [confirming, setConfirming] = useState(false);
  const s = share(p.tally, p.total);

  return (
    <div
      className={`card ${p.open ? "card-open" : ""} ${p.winner ? "card-winner" : ""}`}
      onPointerMove={tilt.onPointerMove}
      onPointerLeave={tilt.onPointerLeave}
      data-testid={`candidate-${p.index}`}
    >
      <button
        type="button"
        className="card-face"
        aria-expanded={p.open}
        aria-controls={panel}
        onClick={() => {
          setConfirming(false);
          p.onToggle();
        }}
      >
        <span className="card-no mono">{String(p.index + 1).padStart(2, "0")}</span>
        <span className="card-name">{p.name}</span>
        <span className="card-tally mono">
          <CountUp value={p.tally} className="count" />
          <span className="sr-only"> votes</span>
        </span>
        <FillBar share={s} tone={p.winner ? "olive" : p.leading ? "clay" : "ink"} />
        {p.winner && <span className="tag tag-olive">Winner</span>}
        {!p.winner && p.leading && p.total > 0 && <span className="tag tag-clay">Leading</span>}
      </button>
      <div id={panel} className="card-panel" hidden={!p.open}>
        <dl className="kv kv-tight">
          <div>
            <dt>Votes</dt>
            <dd className="mono">{p.tally}</dd>
          </div>
          <div>
            <dt>Share</dt>
            <dd className="mono">{pct(s)}</dd>
          </div>
          <div>
            <dt>Index</dt>
            <dd className="mono">{p.index}</dd>
          </div>
        </dl>
        {p.canVote &&
          (confirming ? (
            <div className="confirm">
              <p className="small">
                Your vote is <strong>final and public</strong>: anyone can see this address chose {p.name}.
              </p>
              <div className="btn-row">
                <button type="button" className="btn btn-solid" disabled={p.busy} onClick={p.onVote}>
                  Confirm vote
                </button>
                <button type="button" className="btn btn-quiet" onClick={() => setConfirming(false)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button type="button" className="btn btn-solid" disabled={p.busy} onClick={() => setConfirming(true)}>
              Vote for {p.name}
            </button>
          ))}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ side panels

function Eligibility({ e, status, account }: { e: ElectionDetail; status?: VoterStatus; account?: `0x${string}` }) {
  const wallet = useWallet();
  let title: string;
  let body: React.ReactNode;
  if (!account) {
    title = "Your eligibility";
    body =
      wallet.state.kind === "wrong-chain"
        ? "Switch your wallet to the right network to see whether you can vote."
        : "Connect a wallet to see whether this account can vote here.";
  } else if (!status) {
    title = "Your eligibility";
    body = "Checking the voter list…";
  } else if (status.voted) {
    title = "You voted";
    body = (
      <>
        The chain records a vote from this account. <Link to="/audit#verify">Verify it in the audit trail</Link>.
      </>
    );
  } else if (!status.registered) {
    title = "Not on the voter list";
    body = "This account isn't registered for this election. Only the admin can add voters, during Registration.";
  } else if (e.phaseIndex === 0) {
    title = "You're registered";
    body = e.votingStart
      ? `Voting opens at ${fmtTime(e.votingStart)}.`
      : "Voting opens when the admin moves the election to the Voting phase.";
  } else if (e.phaseIndex === 1) {
    title = "You can vote";
    body = "Open a candidate card to cast your vote. You get one vote, and it can't be changed.";
  } else {
    title = "Voting has closed";
    body = "You were registered but didn't vote before the election ended.";
  }
  return (
    <section className="panel" aria-labelledby="elig-title" data-testid="eligibility">
      <h2 id="elig-title">{title}</h2>
      <p>{body}</p>
    </section>
  );
}

function Result({ e }: { e: ElectionDetail }) {
  const tx = useTx();
  const account = useAccount();
  if (e.phaseIndex !== 2) {
    return (
      <section className="panel" aria-labelledby="res-title">
        <h2 id="res-title">Result</h2>
        <p className="muted">
          Counts are live, but the result can only be finalized after the election ends.
        </p>
      </section>
    );
  }
  if (!e.finalized) {
    return (
      <section className="panel" aria-labelledby="res-title">
        <h2 id="res-title">Ready to finalize</h2>
        <p>Voting has ended. Anyone can record the result on chain: the contract computes the winner or a tie.</p>
        <button
          type="button"
          className="btn btn-solid"
          disabled={!account || isBusy(tx.state)}
          onClick={() => void tx.run({ functionName: "finalize", args: [e.id] })}
        >
          Finalize result
        </button>
        {!account && <p className="muted small">Connect a wallet to send the transaction.</p>}
        <TxStatus state={tx.state} onDismiss={tx.reset} />
      </section>
    );
  }
  const tied = e.tie ? leaders(e.tallies) : [];
  return (
    <section className="panel panel-result" aria-labelledby="res-title" data-testid="result">
      <h2 id="res-title">{e.tie ? "Tie" : "Winner"}</h2>
      {e.tie ? (
        <p>
          {e.totalVotes === 0 ? "No votes were cast; all candidates tie at zero." : `${tied.map((i) => e.candidates[i]).join(" and ")} tie with ${e.tallies[tied[0] ?? 0]} votes each.`}{" "}
          The contract does not break ties.
        </p>
      ) : (
        <p>
          <strong className="result-name">{e.candidates[e.winner]}</strong> with{" "}
          <span className="mono">{e.tallies[e.winner]}</span> of <span className="mono">{e.totalVotes}</span> votes.
        </p>
      )}
      <p className="muted small">Recorded by a Finalized event. See the record below.</p>
    </section>
  );
}

// ------------------------------------------------------------------ lifecycle (scroll-linked)

const EVENT_LABEL: Record<AuditEntry["eventName"], string> = {
  ElectionCreated: "Created",
  VoterRegistered: "Voter registered",
  PhaseChanged: "Phase changed",
  Voted: "Vote recorded",
  Finalized: "Result finalized",
  AdminTransferred: "Admin transferred",
};

function describe(ev: AuditEntry, e: ElectionDetail): React.ReactNode {
  const a = ev.args;
  switch (ev.eventName) {
    case "VoterRegistered":
      return <Hex value={a.voter as string} label="voter address" copy={false} />;
    case "Voted":
      return (
        <>
          <Hex value={a.voter as string} label="voter address" copy={false} /> → {e.candidates[Number(a.candidateIndex)]}
        </>
      );
    case "PhaseChanged":
      return `${PHASES[Number(a.from)]} → ${PHASES[Number(a.to)]}${a.byTimestamp ? " (by schedule)" : ""}`;
    case "Finalized":
      return a.tie ? "Tie" : `Winner: ${e.candidates[Number(a.winner)]}`;
    case "AdminTransferred":
      return <Hex value={a.newAdmin as string} label="new admin" copy={false} />;
    default:
      return `${e.candidateCount} candidates`;
  }
}

/** Which phase an event belongs to, for grouping the chain. */
function phaseOfEvent(ev: AuditEntry, current: number): number {
  return ev.eventName === "PhaseChanged" ? Number(ev.args.to) : current;
}

/**
 * The on-chain record of this election as a vertical chain of blocks. A pinned timeline beside it
 * fills as you scroll, but never past the election's real phase: the scroll position shows where
 * you are in the record, the solid part of the line shows how far the election has actually got.
 */
function Lifecycle({ e }: { e: ElectionDetail }) {
  const log = useAuditLog(e.id);
  const ref = useRef<HTMLElement>(null);
  const fillRef = useRef<HTMLSpanElement>(null);
  const drawRef = useRef<HTMLSpanElement>(null);
  const reduce = useReducedMotion();
  const cap = e.phaseIndex / 2; // 0, 0.5, 1: the rail can't run ahead of the real phase
  useScrollProgress(
    ref,
    (p) => {
      if (fillRef.current) fillRef.current.style.transform = `scaleY(${Math.min(p, cap === 0 ? 0.04 : cap)})`;
      if (drawRef.current) drawRef.current.style.transform = `scaleY(${Math.max(0.02, p)})`;
    },
    { enabled: !reduce },
  );

  // Group events into phase bands, in order.
  const groups: { phase: number; events: AuditEntry[] }[] = [
    { phase: 0, events: [] },
    { phase: 1, events: [] },
    { phase: 2, events: [] },
  ];
  let current = 0;
  for (const ev of log.data ?? []) {
    current = phaseOfEvent(ev, current);
    groups[current]!.events.push(ev);
  }

  return (
    <section ref={ref} className="lifecycle" aria-labelledby="life-title">
      <div className="section-head">
        <h2 id="life-title">On-chain record</h2>
        <p className="muted small">
          Every state change for this election, read from contract logs. Block numbers and transaction hashes are real.
        </p>
      </div>
      <div className="life-grid">
        <div className="life-rail" aria-hidden="true">
          <div className="life-rail-inner">
            <span className="rail-track" />
            <span ref={fillRef} className="rail-fill" style={reduce ? { transform: `scaleY(${cap})` } : undefined} />
            {PHASES.map((name, i) => (
              <span
                key={name}
                className={`rail-stop ${i <= e.phaseIndex ? "reached" : "future"} ${i === e.phaseIndex ? "current" : ""}`}
                style={{ top: `${i * 50}%` }}
              >
                <i />
                <span>{name}</span>
              </span>
            ))}
          </div>
        </div>
        <ol className="chain" aria-label="Events in block order">
          <span ref={drawRef} className="chain-line" aria-hidden="true" />
          {groups.map((g) => (
            <li key={g.phase} className={`band ${g.phase > e.phaseIndex ? "band-future" : ""}`}>
              <h3 className="band-title">
                {PHASES[g.phase]}
                {g.phase > e.phaseIndex && <span className="muted small"> · not reached</span>}
              </h3>
              {g.events.length === 0 ? (
                <p className="muted small band-empty">{g.phase > e.phaseIndex ? "Nothing yet." : "No events in this phase."}</p>
              ) : (
                <ol className="blocks">
                  {g.events.map((ev) => (
                    <li key={ev.key} className={`block block-${ev.eventName}`}>
                      <span className="block-no mono">#{ev.blockNumber.toString()}</span>
                      <span className="block-ev">{EVENT_LABEL[ev.eventName]}</span>
                      <span className="block-args">{describe(ev, e)}</span>
                      <span className="block-tx">
                        <Hex value={ev.txHash} label="transaction hash" head={8} tail={6} />
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
