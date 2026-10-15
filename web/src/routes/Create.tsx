import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import { useAccount } from "../chain/hooks";
import { decodeLogs } from "../chain/reads";
import { isBusy, useTx } from "../chain/tx";
import { TxStatus } from "../components/TxStatus";
import { useNow } from "../lib/useNow";

const enc = new TextEncoder();
const bytes = (s: string) => enc.encode(s).length;

export interface CreateCheck {
  name: string;
  candidates: string[];
  problems: string[];
  start: bigint;
  end: bigint;
  revealEnd: bigint;
}

/** Mirrors the contract's validation so the form can explain problems before anything is sent. */
export function checkCreate(
  nameRaw: string,
  candidatesRaw: string,
  startRaw: string,
  endRaw: string,
  now: number,
  secret = false,
  revealEndRaw = "",
): CreateCheck {
  const name = nameRaw.trim();
  const candidates = candidatesRaw
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const problems: string[] = [];
  if (!name) problems.push("Give the election a name.");
  else if (bytes(name) > 80) problems.push(`The name is ${bytes(name)} bytes; the limit is 80.`);
  if (candidates.length < 2) problems.push("List at least 2 candidates, one per line.");
  if (candidates.length > 32) problems.push(`That's ${candidates.length} candidates; the limit is 32.`);
  candidates.forEach((c, i) => {
    if (bytes(c) > 64) problems.push(`Candidate ${i + 1} is ${bytes(c)} bytes; the limit is 64.`);
  });
  const seen = new Map<string, number>();
  candidates.forEach((c, i) => {
    const prev = seen.get(c);
    if (prev !== undefined) problems.push(`Candidates ${prev + 1} and ${i + 1} have the same name.`);
    else seen.set(c, i);
  });
  const toUnix = (v: string) => (v ? BigInt(Math.floor(new Date(v).getTime() / 1000)) : 0n);
  const start = toUnix(startRaw);
  const end = toUnix(endRaw);
  const revealEnd = secret ? toUnix(revealEndRaw) : 0n;
  if (end !== 0n && end <= BigInt(Math.floor(now / 1000))) problems.push("The voting end must be in the future.");
  if (start !== 0n && end !== 0n && start >= end) problems.push("Voting must start before it ends.");
  if (revealEnd !== 0n && end === 0n) problems.push("A scheduled reveal close needs a scheduled voting close too.");
  if (revealEnd !== 0n && end !== 0n && revealEnd <= end) problems.push("The reveal must close after voting closes.");
  return { name, candidates, problems, start, end, revealEnd };
}

export function CreatePage() {
  const account = useAccount();
  const tx = useTx();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [cands, setCands] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [secret, setSecret] = useState(false);
  const [revealEnd, setRevealEnd] = useState("");
  const [touched, setTouched] = useState(false);

  const now = useNow(5_000);
  const check = useMemo(
    () => checkCreate(name, cands, start, end, now, secret, revealEnd),
    [name, cands, start, end, now, secret, revealEnd],
  );

  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    setTouched(true);
    if (check.problems.length) return;
    const receipt = secret
      ? await tx.run({
          functionName: "createSecretElection",
          args: [check.name, check.candidates, check.start, check.end, check.revealEnd],
        })
      : await tx.run({
          functionName: "createElection",
          args: [check.name, check.candidates, check.start, check.end],
        });
    if (!receipt) return;
    const created = decodeLogs(receipt.logs).find((l) => l.eventName === "ElectionCreated");
    if (created) navigate(`/e/${created.electionId.toString()}`);
  };

  return (
    <section className="page narrow" aria-labelledby="new-title">
      <header className="page-head">
        <p className="eyebrow">New election</p>
        <h1 id="new-title">Create an election</h1>
        <p className="lede">
          Any account can create one and becomes its admin. Candidates are fixed once it's created, so check them now.
        </p>
      </header>
      {!account && (
        <p className="panel">
          Connect a wallet on the right network to create an election. You can fill the form in now.
        </p>
      )}
      <form className="form" onSubmit={submit} noValidate>
        <label className="field">
          <span>Election name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} autoComplete="off" />
          <small className="mono">{bytes(name.trim())}/80 bytes</small>
        </label>
        <label className="field">
          <span>Candidates, one per line</span>
          <textarea value={cands} onChange={(e) => setCands(e.target.value)} rows={6} spellCheck={false} />
          <small className="mono">{check.candidates.length} listed · 2 to 32 · each up to 64 bytes</small>
        </label>
        <fieldset className="field-row ballot-mode">
          <legend>Ballot</legend>
          <label className="choice">
            <input type="radio" name="mode" checked={!secret} onChange={() => setSecret(false)} />
            <span>
              <strong>Open ballot.</strong> Each vote is counted when cast and is public immediately.
            </span>
          </label>
          <label className="choice">
            <input type="radio" name="mode" checked={secret} onChange={() => setSecret(true)} />
            <span>
              <strong>Secret ballot (commit–reveal).</strong> Voters seal their choice during Voting and reveal it in
              an extra Reveal phase. Choices are hidden until reveal, then public. Sealed votes that are never
              revealed are not counted.
            </span>
          </label>
        </fieldset>
        <fieldset className="field-row">
          <legend>Schedule (optional)</legend>
          <label className="field">
            <span>Voting opens</span>
            <input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} />
          </label>
          <label className="field">
            <span>Voting closes</span>
            <input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} />
          </label>
          {secret && (
            <label className="field">
              <span>Reveal closes</span>
              <input type="datetime-local" value={revealEnd} onChange={(e) => setRevealEnd(e.target.value)} />
            </label>
          )}
          <p className="muted small">
            Leave times empty to move phases by hand. A time you set is binding: you can't open or close early.
          </p>
        </fieldset>
        {touched && check.problems.length > 0 && (
          <ul className="problems" role="alert">
            {check.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
        <div className="btn-row">
          <button type="submit" className="btn btn-solid" disabled={!account || isBusy(tx.state)}>
            Create election
          </button>
          <Link to="/" className="btn btn-quiet">
            Cancel
          </Link>
        </div>
        <TxStatus state={tx.state} onDismiss={tx.reset} />
      </form>
    </section>
  );
}
