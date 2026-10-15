import { useId, useMemo, useState } from "react";
import { Link } from "react-router";
import { useAccount, useAuditLog, useElections, useMyStatuses } from "../chain/hooks";
import type { AuditEntry, ElectionSummary, VoterStatus } from "../chain/reads";
import { useRuntime } from "../chain/runtime";
import { Hex } from "../components/Copy";
import { CountUp, Reveal } from "../components/motion";
import { PhaseMark } from "../components/PhaseMark";
import { fmtTime, plural, sameAddr } from "../lib/format";

export function LedgerPage() {
  const elections = useElections();
  const account = useAccount();
  const statuses = useMyStatuses(account);
  const audit = useAuditLog();
  const { health } = useRuntime();

  const created = useMemo(() => {
    const m = new Map<string, AuditEntry>();
    for (const e of audit.data ?? []) if (e.eventName === "ElectionCreated") m.set(e.electionId.toString(), e);
    return m;
  }, [audit.data]);

  const list = elections.data ?? [];
  const totalVotes = list.reduce((n, e) => n + e.totalVotes, 0);
  const open = list.filter((e) => e.phaseIndex === 1).length;

  return (
    <section className="page" aria-labelledby="ledger-title">
      <header className="page-head">
        <p className="eyebrow">Elections ledger</p>
        <h1 id="ledger-title">Every election on this contract, as the chain records it.</h1>
        <p className="lede">
          Tallies, phases and eligibility below are read straight from the contract. Nothing is cached on a server.
        </p>
        <dl className="figures">
          <div>
            <dt>Elections</dt>
            <dd>
              <CountUp value={list.length} />
            </dd>
          </div>
          <div>
            <dt>Open for voting</dt>
            <dd>
              <CountUp value={open} />
            </dd>
          </div>
          <div>
            <dt>Votes recorded</dt>
            <dd>
              <CountUp value={totalVotes} />
            </dd>
          </div>
        </dl>
      </header>

      {elections.isPending && health.code === "present" && <p className="muted">Reading the ledger…</p>}
      {elections.isError && <p className="inline-error">Couldn't read the elections. Retrying when the chain responds.</p>}
      {elections.isSuccess && list.length === 0 && (
        <div className="empty">
          <p>No elections yet.</p>
          <Link className="btn btn-solid" to="/new">
            Create the first one
          </Link>
        </div>
      )}

      {list.length > 0 && (
        <>
          <div className="ledger-cols" aria-hidden="true">
            <span>№</span>
            <span>Election</span>
            <span>Phase</span>
            <span>Votes</span>
            <span>You</span>
            <span />
          </div>
          <ol className="ledger" aria-label="Elections, newest first">
            {list.map((e, i) => (
              <Reveal as="li" index={i} key={e.id.toString()} className="ledger-item">
                <LedgerRow
                  e={e}
                  status={statuses.data?.get(e.id)}
                  isAdmin={sameAddr(e.admin, account)}
                  connected={!!account}
                  created={created.get(e.id.toString())}
                />
              </Reveal>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}

function LedgerRow({ e, status, isAdmin, connected, created }: {
  e: ElectionSummary;
  status: VoterStatus | undefined;
  isAdmin: boolean;
  connected: boolean;
  created: AuditEntry | undefined;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const id = e.id.toString();

  const tags: { label: string; tone: string }[] = [];
  if (isAdmin) tags.push({ label: "Admin", tone: "ink" });
  if (status?.voted) tags.push({ label: "Voted", tone: "olive" });
  else if (status?.registered) tags.push({ label: e.phaseIndex === 2 ? "Did not vote" : "Registered", tone: "clay" });

  return (
    <article className={`row ${open ? "row-open" : ""}`} aria-labelledby={`e-${id}`}>
      <span className="row-no mono">{id.padStart(2, "0")}</span>
      <div className="row-name">
        <h2 id={`e-${id}`}>
          <Link to={`/e/${id}`}>{e.name}</Link>
        </h2>
        <p className="muted small">
          {plural(e.candidateCount, "candidate")} · {plural(e.voterCount, "voter")}
        </p>
      </div>
      <span className="row-phase">
        <PhaseMark phase={e.phase} index={e.phaseIndex} finalized={e.finalized} />
      </span>
      <span className="row-votes mono">
        <span className="row-label">Votes </span>
        <CountUp value={e.totalVotes} />
      </span>
      <span className="row-you">
        {tags.length ? (
          tags.map((t) => (
            <span key={t.label} className={`tag tag-${t.tone}`}>
              {t.label}
            </span>
          ))
        ) : (
          <span className="muted small">{connected ? "Not on list" : "-"}</span>
        )}
      </span>
      <span className="row-actions">
        <button
          type="button"
          className="btn-link"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((o) => !o)}
        >
          {open ? "Hide record" : "On-chain record"}
        </button>
      </span>
      <div id={panelId} className="row-panel" hidden={!open}>
        <dl className="kv">
          <div>
            <dt>Created in tx</dt>
            <dd>{created ? <Hex value={created.txHash} label="creation transaction hash" head={10} tail={8} /> : "…"}</dd>
          </div>
          <div>
            <dt>Block</dt>
            <dd className="mono">{e.createdBlock.toString()}</dd>
          </div>
          <div>
            <dt>Admin</dt>
            <dd>
              <Hex value={e.admin} label="admin address" />
            </dd>
          </div>
          <div>
            <dt>Voting window</dt>
            <dd>
              {e.votingStart === 0n && e.votingEnd === 0n
                ? "Manual (admin advances phases)"
                : `${e.votingStart ? fmtTime(e.votingStart) : "when admin opens"} → ${e.votingEnd ? fmtTime(e.votingEnd) : "when admin closes"}`}
            </dd>
          </div>
        </dl>
        <Link to={`/e/${id}`} className="btn btn-quiet">
          Open election
        </Link>
      </div>
    </article>
  );
}
