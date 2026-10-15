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
          <strong>Your ballot is public.</strong> A vote is a transaction whose data names the candidate. Anyone can
          see which address voted for whom. Hiding this would need a different design, such as commit-reveal or
          zero-knowledge proofs, which Ostrakon doesn't implement.
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
