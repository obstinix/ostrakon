import { useMemo, useState } from "react";
import { Link } from "react-router";
import { useAccount, useAuditLog, useElection, useElections, useMyVotes } from "../chain/hooks";
import { PHASES, type AuditEntry } from "../chain/reads";
import { useRuntime } from "../chain/runtime";
import { Hex } from "../components/Copy";

const EVENTS: AuditEntry["eventName"][] = [
  "ElectionCreated",
  "VoterRegistered",
  "PhaseChanged",
  "Voted",
  "Finalized",
  "AdminTransferred",
];

function Args({ ev }: { ev: AuditEntry }) {
  const a = ev.args;
  const pairs: [string, React.ReactNode][] = [];
  for (const [k, v] of Object.entries(a)) {
    if (k === "electionId") continue;
    let shown: React.ReactNode;
    if (typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v)) shown = <Hex value={v} label={k} />;
    else if ((k === "from" || k === "to") && typeof v === "number") shown = PHASES[v] ?? String(v);
    else if (Array.isArray(v)) shown = v.join(", ");
    else shown = String(v);
    pairs.push([k, shown]);
  }
  return (
    <dl className="args">
      {pairs.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function AuditPage() {
  const { live } = useRuntime();
  const [election, setElection] = useState<string>("all");
  const [kind, setKind] = useState<string>("all");
  const elections = useElections();
  const log = useAuditLog();
  const liveKeys = useMemo(() => new Set(live.map((l) => l.key)), [live]);

  const rows = useMemo(() => {
    const all = [...(log.data ?? [])].reverse();
    return all.filter(
      (r) => (election === "all" || r.electionId.toString() === election) && (kind === "all" || r.eventName === kind),
    );
  }, [log.data, election, kind]);

  return (
    <section className="page" aria-labelledby="audit-title">
      <header className="page-head">
        <p className="eyebrow">Audit trail</p>
        <h1 id="audit-title">The contract's own record, event by event.</h1>
        <p className="lede">
          Decoded from contract logs since deployment. New events appear as blocks arrive. Anyone can rebuild this list
          from a public node.
        </p>
      </header>

      <VerifyMyVote />

      <section aria-labelledby="feed-title" className="feed">
        <div className="section-head">
          <h2 id="feed-title">Event feed</h2>
          <div className="filters">
            <label>
              <span>Election</span>
              <select value={election} onChange={(e) => setElection(e.target.value)}>
                <option value="all">All</option>
                {(elections.data ?? []).map((e) => (
                  <option key={e.id.toString()} value={e.id.toString()}>
                    #{e.id.toString()} · {e.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Event</span>
              <select value={kind} onChange={(e) => setKind(e.target.value)}>
                <option value="all">All</option>
                {EVENTS.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>
        <p className="muted small" aria-live="polite">
          {log.isSuccess ? `${rows.length} event${rows.length === 1 ? "" : "s"}` : "Reading logs…"}
        </p>
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Block</th>
              <th scope="col">Event</th>
              <th scope="col">Election</th>
              <th scope="col">Details</th>
              <th scope="col">Transaction</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className={liveKeys.has(r.key) ? "fresh" : undefined}>
                <td data-label="Block" className="mono">
                  #{r.blockNumber.toString()}
                </td>
                <td data-label="Event">
                  <span className={`ev ev-${r.eventName}`}>{r.eventName}</span>
                </td>
                <td data-label="Election" className="mono">
                  <Link to={`/e/${r.electionId.toString()}`}>#{r.electionId.toString()}</Link>
                </td>
                <td data-label="Details">
                  <Args ev={r} />
                </td>
                <td data-label="Transaction">
                  <Hex value={r.txHash} label="transaction hash" head={10} tail={6} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </section>
  );
}

function VerifyMyVote() {
  const account = useAccount();
  const votes = useMyVotes(account);
  const elections = useElections();
  const names = new Map((elections.data ?? []).map((e) => [e.id.toString(), e]));

  return (
    <section id="verify" className="panel verify" aria-labelledby="verify-title" data-testid="verify">
      <h2 id="verify-title">Verify my vote</h2>
      {!account ? (
        <p>Connect a wallet to look up the votes recorded for that account.</p>
      ) : votes.isPending ? (
        <p className="muted">Searching the logs for this account…</p>
      ) : (votes.data ?? []).length === 0 ? (
        <p>The chain has no vote recorded from this account.</p>
      ) : (
        <>
          <p className="small">
            Each row is a <code>Voted</code> event emitted by the contract for your address. That proves the vote was
            accepted and counted in that election. Ostrakon ballots are not secret: the candidate is part of the public
            record, for you and for everyone else.
          </p>
          <ul className="receipts">
            {(votes.data ?? []).map((v) => {
              const e = names.get(v.electionId.toString());
              return (
                <li key={v.key} className="receipt">
                  <p className="receipt-title">
                    <Link to={`/e/${v.electionId.toString()}`}>
                      #{v.electionId.toString()} {e?.name ?? ""}
                    </Link>
                  </p>
                  <dl className="kv">
                    <div>
                      <dt>Block</dt>
                      <dd className="mono">{v.blockNumber.toString()}</dd>
                    </div>
                    <div>
                      <dt>Transaction</dt>
                      <dd>
                        <Hex value={v.txHash} label="vote transaction hash" head={10} tail={8} />
                      </dd>
                    </div>
                    <div>
                      <dt>Candidate (public)</dt>
                      <dd>
                        <CandidateName electionId={v.electionId} index={Number(v.args.candidateIndex)} />
                      </dd>
                    </div>
                  </dl>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}

function CandidateName({ electionId, index }: { electionId: bigint; index: number }) {
  const e = useElection(electionId);
  return (
    <>
      <span className="mono">#{index}</span> {e.data?.candidates[index] ?? ""}
    </>
  );
}
