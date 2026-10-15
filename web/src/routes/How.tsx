import { Link } from "react-router";

export function HowPage() {
  return (
    <article className="page narrow prose" aria-labelledby="how-title">
      <header className="page-head">
        <p className="eyebrow">How it works</p>
        <h1 id="how-title">What the chain guarantees, and what it doesn't.</h1>
      </header>

      <h2>The pieces</h2>
      <p>
        A single smart contract holds every election: its name, candidates, voter list, phase and tallies. This page is
        only a reader and a transaction builder. Every number it shows comes from the contract, and every change goes
        through a transaction you sign in your own wallet.
      </p>

      <h2>An election's life</h2>
      <ol>
        <li>
          <strong>Registration.</strong> Anyone can create an election and becomes its admin. The admin adds voter
          addresses. Candidates are fixed at creation and can never change.
        </li>
        <li>
          <strong>Voting.</strong> Each registered address can vote once. Registration is closed for good, so the admin
          can't add voters after seeing early results.
        </li>
        <li>
          <strong>Ended.</strong> No more votes. Anyone can then <em>finalize</em>, which records the winner, or a tie,
          on chain.
        </li>
      </ol>
      <p>
        Phases only move forward. If the admin sets a schedule when creating the election, the contract opens and
        closes voting at those times, and the admin can't move them. Times are as accurate as block timestamps, which
        means within a few seconds.
      </p>

      <h2>Who can vote</h2>
      <p>
        The admin decides, in one or both of two ways, during Registration only:
      </p>
      <ul>
        <li>
          <strong>Direct registration:</strong> the admin adds addresses on chain, up to 200 per transaction.
        </li>
        <li>
          <strong>Allowlist:</strong> for large electorates the admin publishes one fingerprint (a Merkle root) of the
          whole list, and shares the list itself as a file. You load that file here; your browser checks that it matches
          the fingerprint and builds a short proof that your address is on it. Your vote then registers you and counts in
          one transaction. The fingerprint is frozen when voting opens, so the list can't change after results appear.
        </li>
      </ul>
      <p>
        Admins hand an election over in two steps: they nominate an address, and only that address can accept. Until it
        does, nothing changes, so a mistyped address can't take or strand an election.
      </p>

      <h2>Open and secret ballots</h2>
      <p>
        <strong>Open ballot:</strong> a vote is counted the moment it is cast, and the choice is public at once.
      </p>
      <p>
        <strong>Secret ballot (commit–reveal):</strong> the election gets one extra phase, <em>Reveal</em>, between
        Voting and Ended.
      </p>
      <ol>
        <li>
          During Voting you <em>seal</em> your vote: your browser picks a random secret, combines it with your choice,
          and sends only a fingerprint (a hash) of the two. The chain records <em>that</em> you voted, not for whom.
          Your browser keeps a receipt with the choice and secret, and offers it as a file.
        </li>
        <li>
          During Reveal you send the choice and secret. The contract checks them against your fingerprint, then counts
          the vote. From that moment your choice is public, just like an open ballot.
        </li>
        <li>A sealed vote that is never revealed is never counted.</li>
      </ol>
      <p>
        What this buys: nobody, including the admin, can see running totals or individual choices while voting is
        open, so early results can't sway later voters. What it doesn't: choices still become public at reveal, and
        during Reveal, people who reveal late can see the partial count and choose not to reveal.
      </p>
      <p>
        <strong>Recovering a lost receipt.</strong> When you seal a vote, your wallet signs a fixed message and that
        signature becomes your secret. Signing the same message again later gives the same secret, so on any device
        "Recover with my wallet" rebuilds the receipt. Because of this, only sign that message on Ostrakon: anyone with
        the signature could work out your choice before you reveal it (they still couldn't change it). If you decline
        to sign, a random secret is used instead and only the receipt file can recover it.
      </p>

      <h2>What you can trust</h2>
      <ul>
        <li>Only registered addresses can vote, and each one only once. The contract enforces this, not this website.</li>
        <li>Tallies can't be edited, and votes can't be removed or changed.</li>
        <li>
          Every step leaves a public event. The <Link to="/audit">audit trail</Link> rebuilds the whole history from
          them.
        </li>
      </ul>

      <h2>Limits you should know</h2>
      <ul>
        <li>
          <strong>Your choice ends up public.</strong> In an open ballot it is public as soon as you vote; in a secret
          ballot, as soon as you reveal. Anyone can then see which address chose whom. Keeping it hidden for good would
          need zero-knowledge proofs or similar, which Ostrakon doesn't implement.
        </li>
        <li>
          <strong>Eligibility is the admin's word.</strong> The contract knows addresses, not people. The admin decides
          which addresses may vote, and could register addresses they control.
        </li>
        <li>
          <strong>Votes can be proven.</strong> Because ballots are public, a voter can prove how they voted to someone
          pressuring them.
        </li>
        <li>
          <strong>Inclusion isn't guaranteed.</strong> A node operator could delay transactions, which matters most
          near a scheduled close.
        </li>
        <li>This is a teaching project without an external audit. Don't use it for binding elections.</li>
      </ul>

      <h2>Trying it locally</h2>
      <p>
        <code>npm run dev</code> starts a local chain with five demo elections. Import one of the printed test keys
        (<code>npm run keys</code>) into a browser wallet to vote or administer. Those keys are public: never use them
        on a real network.
      </p>
    </article>
  );
}
