import { useId, useRef, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router";
import { zeroAddress, zeroHash, type Address, type Hex as HexStr } from "viem";
import { signMessage } from "wagmi/actions";
import { useQuery } from "@tanstack/react-query";
import { useAccount, useAuditLog, useCommitment, useElection, useVoterStatus } from "../chain/hooks";
import { decodeError } from "../chain/errors";
import {
  commitmentHash,
  getAllowlist,
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
import { useKeyBase, useRuntime } from "../chain/runtime";
import { isBusy, useTx } from "../chain/tx";
import { useWallet } from "../chain/wallet";
import { Hex } from "../components/Copy";
import { CountUp, FillBar, useReducedMotion, useScrollProgress, useTilt } from "../components/motion";
import { AllowlistLoader, useAllowlistMembership, type Membership } from "../components/Allowlist";
import { Pending } from "../components/Pending";
import { PhaseMark } from "../components/PhaseMark";
import { TxStatus } from "../components/TxStatus";
import { fmtTime, pct, plural, sameAddr } from "../lib/format";
import { downloadReceipt, loadReceipt, newSalt, parseReceipt, saveReceipt, type Receipt } from "../lib/receipts";
import { findChoice, recoveryMessage, saltFromSignature } from "../lib/recovery";

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
  return <ElectionLoaded e={election.data} status={status.data} account={account} />;
}

function ElectionLoaded({ e, status, account }: { e: ElectionDetail; status?: VoterStatus; account?: Address }) {
  const isAdmin = sameAddr(e.admin, account);
  const allow = useAllowlistMembership(e, account);
  const membership = allow.membership;

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
        {e.allowlistRoot !== zeroHash && (
          <p className="small">
            Eligibility: an allowlist of addresses (Merkle root <Hex value={e.allowlistRoot} label="allowlist root" />)
            {" "}plus any voters the admin registered directly. Listed voters register themselves when they vote.
          </p>
        )}
        <Nomination e={e} account={account} />
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
          <Ballot e={e} status={status} account={account} membership={membership} />
        </section>
        <aside className="el-side" aria-label="Your status and result">
          {e.secret ? (
            <SecretPanel e={e} status={status} account={account} membership={membership} allow={allow} />
          ) : (
            <Eligibility e={e} status={status} account={account} membership={membership} allow={allow} />
          )}
          <Result e={e} />
        </aside>
      </div>

      <Lifecycle e={e} />
    </article>
  );
}

/** Two-step admin hand-over: the nominee accepts here; everyone else sees that one is pending. */
function Nomination({ e, account }: { e: ElectionDetail; account?: Address }) {
  const tx = useTx();
  if (e.pendingAdmin === zeroAddress) return null;
  if (!sameAddr(e.pendingAdmin, account)) {
    return (
      <p className="small">
        Admin hand-over pending: <Hex value={e.pendingAdmin} label="nominated admin" /> has been nominated and hasn't
        accepted yet.
      </p>
    );
  }
  return (
    <section className="panel nomination" aria-labelledby="nom-title" data-testid="nomination">
      <h2 id="nom-title">You've been nominated as admin</h2>
      <p>
        The current admin wants to hand this election to you. Accepting makes you its admin: you'll run its phases and
        the previous admin loses control.
      </p>
      <button
        type="button"
        className="btn btn-solid"
        disabled={isBusy(tx.state)}
        onClick={() => void tx.run({ functionName: "acceptAdmin", args: [e.id] })}
      >
        Accept admin role
      </button>
      <TxStatus state={tx.state} onDismiss={tx.reset} />
    </section>
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

function Ballot({
  e,
  status,
  account,
  membership,
}: {
  e: ElectionDetail;
  status?: VoterStatus;
  account?: Address;
  membership: Membership;
}) {
  const { runtime } = useRuntime();
  const tx = useTx();
  const [open, setOpen] = useState<number | null>(null);
  const [signing, setSigning] = useState<string | null>(null);
  // A listed voter who hasn't claimed yet votes with their proof, registering in the same transaction.
  const proof = !status?.registered && membership.status === "member" ? membership.proof : null;
  const eligible = !!status?.registered || !!proof;
  const canVote = e.phase === "Voting" && !!account && !!status && eligible && !status.voted;
  const visible = talliesVisible(e);
  const lead = visible && e.totalVotes > 0 ? leaders(e.tallies) : [];

  const castOpen = (i: number) =>
    void (proof
      ? tx.run({ functionName: "voteWithProof", args: [e.id, BigInt(i), proof] })
      : tx.run({ functionName: "vote", args: [e.id, BigInt(i)] }));

  const seal = async (i: number) => {
    if (!account) return;
    // Prefer a salt the wallet can reproduce later (receipt recovery); fall back to random.
    let salt: HexStr;
    let recoverable = false;
    setSigning("Sign the message in your wallet. It makes your receipt recoverable and costs nothing.");
    try {
      const sig = await signMessage(runtime.wagmi, {
        message: recoveryMessage(runtime.chain.id, runtime.deployment.address, e.id),
      });
      salt = saltFromSignature(sig);
      recoverable = true;
      setSigning(null);
    } catch (err) {
      console.error("[ostrakon] recovery signature declined or failed; using a random salt", err);
      salt = newSalt();
      setSigning(
        "No signature, so this vote uses a random secret: keep the receipt (download it below), because your wallet can't rebuild it.",
      );
    }
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
      recoverable,
    });
    void (proof
      ? tx.run({ functionName: "commitVoteWithProof", args: [e.id, commitment, proof] })
      : tx.run({ functionName: "commitVote", args: [e.id, commitment] }));
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
              onVote={() => (e.secret ? void seal(i) : castOpen(i))}
            />
          </li>
        ))}
      </ul>
      {signing && (
        <p className="small signing" role="status">
          {signing}
        </p>
      )}
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

type AllowlistApi = ReturnType<typeof useAllowlistMembership>;

/** Eligibility copy for an unregistered account in an election that has an allowlist. */
function allowlistState(e: ElectionDetail, membership: Membership, allow: AllowlistApi, uri: string) {
  switch (membership.status) {
    case "member":
      return {
        title: e.phase === "Registration" ? "You're on the allowlist" : "You can vote (allowlist)",
        body:
          e.phase === "Registration"
            ? "Your address is on the published list. When voting opens you'll be registered in the same transaction as your vote."
            : "Your address is on the published list. Your vote registers you and counts in one transaction.",
      };
    case "not-member":
      return {
        title: "Not on the allowlist",
        body: "The published list doesn't include this address, and the admin hasn't registered it directly.",
      };
    case "checking":
      return { title: "Checking the allowlist", body: "Checking your address against the list…" };
    default:
      return {
        title: "Check the allowlist",
        body: <AllowlistLoader uri={uri} problem={allow.problem} offer={allow.offer} fetchFrom={allow.fetchFrom} />,
      };
  }
}

function useAllowlistUri(e: ElectionDetail): string {
  const { runtime } = useRuntime();
  const base = useKeyBase();
  const q = useQuery({
    queryKey: [...base, "allowlist", e.id.toString()],
    queryFn: () => getAllowlist(runtime.client, runtime.deployment.address, e.id),
    enabled: e.allowlistRoot !== zeroHash,
  });
  return q.data?.uri ?? "";
}

function Eligibility({
  e,
  status,
  account,
  membership,
  allow,
}: {
  e: ElectionDetail;
  status?: VoterStatus;
  account?: Address;
  membership: Membership;
  allow: AllowlistApi;
}) {
  const wallet = useWallet();
  const uri = useAllowlistUri(e);
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
  } else if (!status.registered && membership.status !== "none" && e.phase !== "Ended") {
    ({ title, body } = allowlistState(e, membership, allow, uri));
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
function SecretPanel({
  e,
  status,
  account,
  membership,
  allow,
}: {
  e: ElectionDetail;
  status?: VoterStatus;
  account?: Address;
  membership: Membership;
  allow: AllowlistApi;
}) {
  const { runtime } = useRuntime();
  const wallet = useWallet();
  const tx = useTx();
  const uri = useAllowlistUri(e);
  const commitment = useCommitment(e.id, account, !!status?.voted);
  const [pasted, setPasted] = useState("");
  const [pasteProblem, setPasteProblem] = useState<string | null>(null);
  const [recoverMsg, setRecoverMsg] = useState<string | null>(null);
  const [, setReceiptVersion] = useState(0); // bump to re-read localStorage after a recovery

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

  /** Rebuild the receipt from a fresh wallet signature (works if the vote was sealed with one). */
  const recover = async () => {
    setRecoverMsg(null);
    if (!account || !onChain) return;
    try {
      const sig = await signMessage(runtime.wagmi, {
        message: recoveryMessage(runtime.chain.id, runtime.deployment.address, e.id),
      });
      const salt = saltFromSignature(sig);
      const idx = findChoice(
        runtime.chain.id,
        runtime.deployment.address,
        e.id,
        account,
        salt,
        e.candidateCount,
        onChain,
      );
      if (idx === null) {
        setRecoverMsg(
          "Your wallet's signature doesn't reproduce this sealed vote: it was sealed with a random secret. Use the receipt file instead.",
        );
        return;
      }
      saveReceipt({
        v: 1,
        chainId: runtime.chain.id,
        contract: runtime.deployment.address,
        electionId: e.id.toString(),
        voter: account,
        candidateIndex: idx,
        salt,
        commitment: onChain,
        recoverable: true,
      });
      setReceiptVersion((n) => n + 1);
      setRecoverMsg("Receipt recovered from your wallet.");
    } catch (err) {
      setRecoverMsg(decodeError(err).message);
    }
  };
  const recoverButton = (
    <button type="button" className="btn btn-quiet" onClick={() => void recover()}>
      Recover with my wallet
    </button>
  );

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
  } else if (
    !status.registered &&
    membership.status !== "none" &&
    (e.phase === "Registration" || e.phase === "Voting")
  ) {
    ({ title, body } = allowlistState(e, membership, allow, uri));
    if (membership.status === "member") {
      body = (
        <>
          {body} Open a candidate card to seal your vote; it stays hidden until you reveal it.
        </>
      );
    }
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
        The chain holds your sealed vote. This browser has the receipt you'll need to reveal it
        {stored?.recoverable ? ", and your wallet can rebuild it if it's lost" : " (your wallet can't rebuild this one)"}.{" "}
        <button type="button" className="btn-link" onClick={() => downloadReceipt(stored!)}>
          Download a copy
        </button>{" "}
        in case you switch browsers or clear site data.
      </>
    ) : (
      <>
        The chain holds your sealed vote, but this browser has no receipt for it. If you sealed it with a wallet
        signature you can rebuild the receipt now; otherwise bring the receipt file when Reveal opens.
        <span className="btn-row">{recoverButton}</span>
      </>
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
        No matching receipt in this browser. Rebuild it with the wallet that sealed the vote:
        <span className="btn-row">{recoverButton}</span>
        Or paste the contents of your receipt file:
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
      {recoverMsg && (
        <p className="small" role="status">
          {recoverMsg}
        </p>
      )}
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
    case "AdminTransferStarted":
      return ev.args.pendingAdmin === zeroAddress ? "Hand-over cancelled" : "Admin nominated";
    case "AdminTransferred":
      return "Admin transferred";
    case "AllowlistSet":
      return ev.args.root === zeroHash ? "Allowlist removed" : "Allowlist published";
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
    case "AdminTransferStarted":
      return a.pendingAdmin === zeroAddress ? "-" : <Hex value={a.pendingAdmin as string} label="nominee" copy={false} />;
    case "AllowlistSet":
      return a.root === zeroHash ? "-" : <Hex value={a.root as string} label="allowlist root" copy={false} />;
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
