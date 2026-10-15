import { useId, useRef, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router";
import { zeroHash, type Address } from "viem";
import { useAccount, useAuditLog, useCommitment, useElection, useVoterStatus } from "../chain/hooks";
import {
  commitmentHash,
  leaders,
  PHASES,
  phasesFor,
  phaseStep,
  share,
  type AuditEntry,
  type ElectionDetail,
  type PhaseName,
  type VoterStatus,
} from "../chain/reads";
import { useRuntime } from "../chain/runtime";
import { isBusy, useTx } from "../chain/tx";
import { useWallet } from "../chain/wallet";
import { Hex } from "../components/Copy";
import { CountUp, FillBar, useReducedMotion, useScrollProgress, useTilt } from "../components/motion";
import { Pending } from "../components/Pending";
import { PhaseMark } from "../components/PhaseMark";
import { TxStatus } from "../components/TxStatus";
import { fmtTime, pct, plural, sameAddr } from "../lib/format";
import { downloadReceipt, loadReceipt, newSalt, parseReceipt, saveReceipt, type Receipt } from "../lib/receipts";

export function parseId(raw: string | undefined): bigint | null {
  return raw && /^\d{1,9}$/.test(raw) && raw !== "0" ? BigInt(raw) : null;
}

/** Tallies are meaningful (non-hidden) for open ballots always, for secret ballots once Reveal starts. */
function talliesVisible(e: ElectionDetail): boolean {
  return !e.secret || e.phase === "Reveal" || e.phase === "Ended";
}

export function ElectionPage() {
  const id = parseId(useParams().id);
  const election = useElection(id);
  const account = useAccount();
  const status = useVoterStatus(id, account);

  if (id === null) return <NotFound />;
  if (election.isPending) return <Pending what="election" />;
  if (election.isError) return <NotFound />;
  const e = election.data;
  const isAdmin = sameAddr(e.admin, account);

  let countLine: string;
  if (!e.secret) countLine = `${plural(e.totalVotes, "vote")} of ${plural(e.voterCount, "registered voter")}`;
  else if (e.phase === "Registration" || e.phase === "Voting")
    countLine = `${plural(e.committed, "sealed vote")} of ${plural(e.voterCount, "registered voter")}`;
  else countLine = `${e.totalVotes} of ${plural(e.committed, "sealed vote")} revealed and counted`;

  return (
    <article className="page election" aria-labelledby="el-title">
      <header className="page-head">
        <p className="eyebrow">Election No. {e.id.toString()}</p>
        <h1 id="el-title">{e.name}</h1>
        <div className="el-meta">
          <PhaseMark phase={e.phase} secret={e.secret} finalized={e.finalized} />
          {e.secret && <span className="tag tag-ink">Secret ballot</span>}
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
        {e.secret && (
          <p className="small secret-note">
            Votes are sealed during Voting and only opened by each voter in the Reveal phase. Until then the chain
            shows <em>that</em> an address voted, not for whom. After reveal, choices are public. A sealed vote that is
            never revealed is never counted.
          </p>
        )}
      </header>

      <div className="el-grid">
        <section aria-labelledby="cand-title" className="el-candidates">
          <div className="section-head">
            <h2 id="cand-title">Candidates</h2>
            <p className="muted small" data-testid="count-line">
              {countLine}
            </p>
          </div>
          <Ballot e={e} status={status.data} account={account} />
        </section>
        <aside className="el-side" aria-label="Your status and result">
          {e.secret ? (
            <SecretPanel e={e} status={status.data} account={account} />
          ) : (
            <Eligibility e={e} status={status.data} account={account} />
          )}
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
      {e.votingEnd ? <strong>{fmtTime(e.votingEnd)}</strong> : "closes when the admin advances"}
      {e.secret && (
        <>
          {" "}
          · reveal closes {e.revealEnd ? <strong>{fmtTime(e.revealEnd)}</strong> : "when the admin advances"}
        </>
      )}
      . The contract enforces these times; the admin can't move them.
    </p>
  );
}

// ------------------------------------------------------------------ ballot

function Ballot({ e, status, account }: { e: ElectionDetail; status?: VoterStatus; account?: Address }) {
  const { runtime } = useRuntime();
  const tx = useTx();
  const [open, setOpen] = useState<number | null>(null);
  const canVote = e.phase === "Voting" && !!account && !!status?.registered && !status.voted;
  const visible = talliesVisible(e);
  const lead = visible && e.totalVotes > 0 ? leaders(e.tallies) : [];

  const castOpen = (i: number) => void tx.run({ functionName: "vote", args: [e.id, BigInt(i)] });

  const seal = (i: number) => {
    if (!account) return;
    const salt = newSalt();
    const commitment = commitmentHash(
      runtime.chain.id,
      runtime.deployment.address,
      e.id,
      account,
      BigInt(i),
      salt,
    );
    // Save before sending: if the transaction lands and the tab closes, the receipt still exists.
    saveReceipt({
      v: 1,
      chainId: runtime.chain.id,
      contract: runtime.deployment.address,
      electionId: e.id.toString(),
      voter: account,
      candidateIndex: i,
      salt,
      commitment,
    });
    void tx.run({ functionName: "commitVote", args: [e.id, commitment] });
  };

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
              hidden={!visible}
              leading={lead.includes(i)}
              winner={e.finalized && !e.tie && e.winner === i}
              open={open === i}
              onToggle={() => setOpen(open === i ? null : i)}
              canVote={canVote}
              secret={e.secret}
              busy={isBusy(tx.state)}
              onVote={() => (e.secret ? seal(i) : castOpen(i))}
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
  hidden: boolean;
  leading: boolean;
  winner: boolean;
  open: boolean;
  onToggle: () => void;
  canVote: boolean;
  secret: boolean;
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
          {p.hidden ? (
            <span className="sealed" title="Sealed until the Reveal phase">
              <span aria-hidden="true">sealed</span>
              <span className="sr-only">count hidden until reveal</span>
            </span>
          ) : (
            <>
              <CountUp value={p.tally} className="count" />
              <span className="sr-only"> votes</span>
            </>
          )}
        </span>
        <FillBar share={p.hidden ? 0 : s} tone={p.winner ? "olive" : p.leading ? "clay" : "ink"} />
        {p.winner && <span className="tag tag-olive">Winner</span>}
        {!p.winner && p.leading && p.total > 0 && <span className="tag tag-clay">Leading</span>}
      </button>
      <div id={panel} className="card-panel" hidden={!p.open}>
        <dl className="kv kv-tight">
          <div>
            <dt>{p.secret ? "Revealed votes" : "Votes"}</dt>
            <dd className="mono">{p.hidden ? "-" : p.tally}</dd>
          </div>
          <div>
            <dt>Share</dt>
            <dd className="mono">{p.hidden ? "-" : pct(s)}</dd>
          </div>
          <div>
            <dt>Index</dt>
            <dd className="mono">{p.index}</dd>
          </div>
        </dl>
        {p.canVote &&
          (confirming ? (
            <div className="confirm">
              {p.secret ? (
                <p className="small">
                  Your choice stays <strong>hidden until you reveal it</strong> in the Reveal phase. This browser keeps
                  a receipt; download a copy too. <strong>Without the receipt the vote can't be counted.</strong>
                </p>
              ) : (
                <p className="small">
                  Your vote is <strong>final and public</strong>: anyone can see this address chose {p.name}.
                </p>
              )}
              <div className="btn-row">
                <button type="button" className="btn btn-solid" disabled={p.busy} onClick={p.onVote}>
                  {p.secret ? "Confirm sealed vote" : "Confirm vote"}
                </button>
                <button type="button" className="btn btn-quiet" onClick={() => setConfirming(false)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button type="button" className="btn btn-solid" disabled={p.busy} onClick={() => setConfirming(true)}>
              {p.secret ? `Seal vote for ${p.name}` : `Vote for ${p.name}`}
            </button>
          ))}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ side panels

function Eligibility({ e, status, account }: { e: ElectionDetail; status?: VoterStatus; account?: Address }) {
  const wallet = useWallet();
  let title: string;
  let body: ReactNode;
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
  } else if (e.phase === "Registration") {
    title = "You're registered";
    body = e.votingStart
      ? `Voting opens at ${fmtTime(e.votingStart)}.`
      : "Voting opens when the admin moves the election to the Voting phase.";
  } else if (e.phase === "Voting") {
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

/** Secret ballot: eligibility, receipt safekeeping and the reveal action, by phase. */
function SecretPanel({ e, status, account }: { e: ElectionDetail; status?: VoterStatus; account?: Address }) {
  const { runtime } = useRuntime();
  const wallet = useWallet();
  const tx = useTx();
  const commitment = useCommitment(e.id, account, !!status?.voted);
  const [pasted, setPasted] = useState("");
  const [pasteProblem, setPasteProblem] = useState<string | null>(null);

  const stored = account ? loadReceipt(runtime.chain.id, runtime.deployment.address, e.id, account) : null;
  const onChain = commitment.data;
  const storedMatches = !!stored && !!onChain && onChain !== zeroHash && stored.commitment === onChain;

  /** A receipt is usable only if it is for this voter/election and reproduces the on-chain commitment. */
  const usable = (r: Receipt | null): r is Receipt =>
    !!r &&
    !!account &&
    sameAddr(r.voter, account) &&
    r.electionId === e.id.toString() &&
    sameAddr(r.contract, runtime.deployment.address) &&
    r.chainId === runtime.chain.id &&
    commitmentHash(r.chainId, r.contract, e.id, account, BigInt(r.candidateIndex), r.salt) === onChain;

  const reveal = (r: Receipt) =>
    void tx.run({ functionName: "revealVote", args: [e.id, BigInt(r.candidateIndex), r.salt] });

  let title: string;
  let body: ReactNode;
  if (!account) {
    title = "Your eligibility";
    body =
      wallet.state.kind === "wrong-chain"
        ? "Switch your wallet to the right network to see whether you can vote."
        : "Connect a wallet to see whether this account can vote here.";
  } else if (!status) {
    title = "Your eligibility";
    body = "Checking the voter list…";
  } else if (!status.registered) {
    title = "Not on the voter list";
    body = "This account isn't registered for this election. Only the admin can add voters, during Registration.";
  } else if (status.revealed) {
    title = "Your vote is counted";
    body = (
      <>
        You revealed your sealed vote and the contract counted it. It is now public.{" "}
        <Link to="/audit#verify">See it in the audit trail</Link>.
      </>
    );
  } else if (!status.voted) {
    if (e.phase === "Registration") {
      title = "You're registered";
      body = "Sealed voting opens when the election moves to the Voting phase.";
    } else if (e.phase === "Voting") {
      title = "You can vote";
      body = "Open a candidate card to seal your vote. It stays hidden until you reveal it.";
    } else {
      title = "Voting has closed";
      body = "You were registered but didn't seal a vote before voting closed.";
    }
  } else if (e.phase === "Voting") {
    title = "Your vote is sealed";
    body = storedMatches ? (
      <>
        The chain holds your sealed vote. This browser has the receipt you'll need to reveal it.{" "}
        <button type="button" className="btn-link" onClick={() => downloadReceipt(stored!)}>
          Download a copy
        </button>{" "}
        in case you switch browsers or clear site data.
      </>
    ) : (
      "The chain holds your sealed vote. This browser has no receipt for it: when Reveal opens, bring the receipt file from the device you sealed it on."
    );
  } else if (e.phase === "Reveal") {
    title = "Reveal your vote";
    body = storedMatches ? (
      <>
        Your receipt is in this browser. Revealing makes your choice public and counts it.
        <span className="btn-row reveal-row">
          <button
            type="button"
            className="btn btn-solid"
            disabled={isBusy(tx.state)}
            onClick={() => reveal(stored!)}
          >
            Reveal my vote for {e.candidates[stored!.candidateIndex] ?? `#${stored!.candidateIndex}`}
          </button>
        </span>
      </>
    ) : (
      <>
        No matching receipt in this browser. Paste the contents of your receipt file:
        <label className="field reveal-paste">
          <span className="sr-only">Receipt JSON</span>
          <textarea
            className="mono"
            rows={4}
            value={pasted}
            spellCheck={false}
            onChange={(ev) => {
              setPasted(ev.target.value);
              setPasteProblem(null);
            }}
          />
        </label>
        <span className="btn-row">
          <button
            type="button"
            className="btn btn-solid"
            disabled={!pasted.trim() || isBusy(tx.state)}
            onClick={() => {
              const r = parseReceipt(pasted);
              if (!r) return setPasteProblem("That isn't an Ostrakon receipt.");
              if (!usable(r))
                return setPasteProblem("That receipt is for a different account, election or sealed vote.");
              saveReceipt(r);
              reveal(r);
            }}
          >
            Reveal with this receipt
          </button>
        </span>
        {pasteProblem && <span className="inline-error">{pasteProblem}</span>}
      </>
    );
  } else {
    title = "Not counted";
    body = "Your sealed vote was never revealed before the reveal phase closed, so it was not counted.";
  }

  return (
    <section className="panel" aria-labelledby="elig-title" data-testid="eligibility">
      <h2 id="elig-title">{title}</h2>
      <div className="panel-body">{body}</div>
      <TxStatus state={tx.state} onDismiss={tx.reset} />
    </section>
  );
}

function Result({ e }: { e: ElectionDetail }) {
  const tx = useTx();
  const account = useAccount();
  if (e.phase === "Reveal") {
    return (
      <section className="panel" aria-labelledby="res-title">
        <h2 id="res-title">Reveal in progress</h2>
        <p>
          <span className="mono">{e.totalVotes}</span> of <span className="mono">{e.committed}</span> sealed votes
          revealed so far. Counts include revealed votes only; the result can be finalized once the Reveal phase
          closes.
        </p>
      </section>
    );
  }
  if (e.phase !== "Ended") {
    return (
      <section className="panel" aria-labelledby="res-title">
        <h2 id="res-title">Result</h2>
        <p className="muted">
          {e.secret
            ? "Votes stay sealed until the Reveal phase; the result can be finalized after reveal closes."
            : "Counts are live, but the result can only be finalized after the election ends."}
        </p>
      </section>
    );
  }
  if (!e.finalized) {
    return (
      <section className="panel" aria-labelledby="res-title">
        <h2 id="res-title">Ready to finalize</h2>
        <p>
          Voting has ended. Anyone can record the result on chain: the contract computes the winner or a tie
          {e.secret ? " from the revealed votes" : ""}.
        </p>
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
          {e.totalVotes === 0
            ? "No votes were counted; all candidates tie at zero."
            : `${tied.map((i) => e.candidates[i]).join(" and ")} tie with ${e.tallies[tied[0] ?? 0]} votes each.`}{" "}
          The contract does not break ties.
        </p>
      ) : (
        <p>
          <strong className="result-name">{e.candidates[e.winner]}</strong> with{" "}
          <span className="mono">{e.tallies[e.winner]}</span> of <span className="mono">{e.totalVotes}</span> votes.
        </p>
      )}
      {e.secret && e.committed > e.totalVotes && (
        <p className="small">
          {plural(e.committed - e.totalVotes, "sealed vote")} never revealed and not counted.
        </p>
      )}
      <p className="muted small">Recorded by a Finalized event. See the record below.</p>
    </section>
  );
}

// ------------------------------------------------------------------ lifecycle (scroll-linked)

function eventLabel(ev: AuditEntry, e: ElectionDetail): string {
  switch (ev.eventName) {
    case "ElectionCreated":
      return "Created";
    case "VoterRegistered":
      return "Voter registered";
    case "PhaseChanged":
      return "Phase changed";
    case "Voted":
      return e.secret ? "Vote revealed" : "Vote recorded";
    case "VoteCommitted":
      return "Vote sealed";
    case "Finalized":
      return "Result finalized";
    case "AdminTransferred":
      return "Admin transferred";
  }
}

function describe(ev: AuditEntry, e: ElectionDetail): ReactNode {
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
    case "VoteCommitted":
      return (
        <>
          <Hex value={a.voter as string} label="voter address" copy={false} /> · choice hidden
        </>
      );
    case "PhaseChanged":
      return `${PHASES[Number(a.from)]} → ${PHASES[Number(a.to)]}${a.byTimestamp ? " (by schedule)" : ""}`;
    case "Finalized":
      return a.tie ? "Tie" : `Winner: ${e.candidates[Number(a.winner)]}`;
    case "AdminTransferred":
      return <Hex value={a.newAdmin as string} label="new admin" copy={false} />;
    default:
      return `${e.candidateCount} candidates${e.secret ? " · secret ballot" : ""}`;
  }
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
  const list = phasesFor(e);
  const step = phaseStep(e);
  const cap = step / (list.length - 1); // the rail can't run ahead of the real phase
  useScrollProgress(
    ref,
    (p) => {
      if (fillRef.current) fillRef.current.style.transform = `scaleY(${Math.min(p, cap === 0 ? 0.04 : cap)})`;
      if (drawRef.current) drawRef.current.style.transform = `scaleY(${Math.max(0.02, p)})`;
    },
    { enabled: !reduce },
  );

  // Group events into phase bands, in order.
  const groups = list.map((phase) => ({ phase, events: [] as AuditEntry[] }));
  let current: PhaseName = "Registration";
  for (const ev of log.data ?? []) {
    if (ev.eventName === "PhaseChanged") current = PHASES[Number(ev.args.to)] ?? current;
    groups.find((g) => g.phase === current)?.events.push(ev);
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
            {list.map((name, i) => (
              <span
                key={name}
                className={`rail-stop ${i <= step ? "reached" : "future"} ${i === step ? "current" : ""}`}
                style={{ top: `${(i * 100) / (list.length - 1)}%` }}
              >
                <i />
                <span>{name}</span>
              </span>
            ))}
          </div>
        </div>
        <ol className="chain" aria-label="Events in block order">
          <span ref={drawRef} className="chain-line" aria-hidden="true" />
          {groups.map((g, gi) => (
            <li key={g.phase} className={`band ${gi > step ? "band-future" : ""}`}>
              <h3 className="band-title">
                {g.phase}
                {gi > step && <span className="muted small"> · not reached</span>}
              </h3>
              {g.events.length === 0 ? (
                <p className="muted small band-empty">{gi > step ? "Nothing yet." : "No events in this phase."}</p>
              ) : (
                <ol className="blocks">
                  {g.events.map((ev) => (
                    <li key={ev.key} className={`block block-${ev.eventName}`}>
                      <span className="block-no mono">#{ev.blockNumber.toString()}</span>
                      <span className="block-ev">{eventLabel(ev, e)}</span>
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
