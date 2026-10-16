# Ostrakon: features and changes

A summary of what Ostrakon does, how its rules are enforced, and what changed in each round of work. Finding IDs (B-, C-, F-, R-) refer to [AUDIT.md](AUDIT.md).

## Overview
- **Anyone can create an election** and becomes *that election's* admin. There is no global owner (C-06).
- **Phases** run Registration → Voting → (Reveal) → Ended. They only move forward, and an optional voting window binds the admin too. `finalize` records a winner or a tie on chain (C-01, C-02).
- **Open or secret ballot.** In a secret ballot, voters seal a hash of their choice during Voting and reveal it in an extra Reveal phase. Only revealed votes are counted.
- **Read without a wallet.** The web app (React 19, TypeScript, Vite, viem, wagmi) reads the chain directly. A wallet is only needed to send transactions (F-01).
- **Event-driven updates.** Contract events are watched over WebSocket, with log polling as a fallback. All tallies come from one `getTallies` call (F-06).
- **Demo data.** `npm run dev` seeds seven elections in different phases, including a secret ballot and an allowlist election.

## Screens
Ledger, Election, Manage, New election, Audit, and How it works, plus a persistent network bar. Any EIP-1193 or EIP-6963 browser wallet works.

## Stack

| Layer | Choice |
|---|---|
| Contract | Solidity 0.8.30 (`pragma ^0.8.24`), Foundry 1.8 (forge, anvil, cast) |
| Frontend | React 19, Vite 8, React Router, TypeScript 6 |
| Chain client | viem 2 + wagmi 3 + TanStack Query 5 |
| Local chain | Anvil, chain id **31337** |
| Testing and analysis | Foundry (unit, fuzz, invariant), Vitest, Playwright, Slither |

[STACK.md](STACK.md) explains each choice.

## Rules
1. Anyone can create an election with **2–32 unique, non-empty candidates** of ≤ 64 bytes each, a name of ≤ 80 bytes, and an optional voting window.
2. Voters are registered **only during Registration**. Bulk registration is capped at 200 per transaction (the UI splits longer lists). The voter list is **public** (C-07).
3. The admin advances the phase. A set window binds the admin too.
4. Registered voters vote once, only during Voting.
5. Anyone can view everything without a wallet.
6. Each election's **Manage** screen is shown only to that election's admin.
7. Anyone can **finalize** an ended election; the result (winner or tie) is stored and emitted.
8. Anyone can verify their own vote from the `Voted` event (Audit → Verify my vote).
9. The creator chooses an **open or secret ballot**. In a secret ballot a registered voter seals one commitment during Voting and reveals it during Reveal.
10. For large electorates the admin can publish a **Merkle-root allowlist** instead of registering every address. Listed voters register themselves with a proof, during Registration or in the same transaction as their vote. The list is frozen when voting opens.
11. The admin role is handed over in **two steps**: nominate, then the nominee accepts. The admin can cancel.

## Roles

| Role | Functions | Enforced by |
|---|---|---|
| Anyone | `createElection`, `createSecretElection`, `finalize`, `syncPhase`, all views | none (after `finalize`: phase must be Ended) |
| Election admin | `registerVoter`, `registerVoters`, `setAllowlist`, `advancePhase`, `transferAdmin`, `cancelAdminTransfer` | `onlyAdmin(electionId)` → `NotAdmin` |
| Nominated admin | `acceptAdmin` | `pendingAdmin == msg.sender` → `NotPendingAdmin` |
| Allowlisted address | `registerWithProof`, `voteWithProof`, `commitVoteWithProof` | Merkle proof of `msg.sender` against the stored root → `NotOnAllowlist` |
| Registered voter (secret ballot) | `commitVote(electionId, commitment)` in Voting, `revealVote(electionId, candidateIndex, salt)` in Reveal | phase, `registered`, one commitment, commitment must match on reveal |
| Registered voter | `vote(electionId, candidateIndex)` | phase == Voting, `registered`, `!voted` |

The election struct holds `admin`, `votingStart`, `votingEnd`, `storedPhase`, `finalized`, `tie`, `winner`, `createdBlock`, `totalVotes`, and `tallies[]` (an array, so all tallies are one read). An id is valid when `1 ≤ id ≤ electionCount`.

There are nine events: `ElectionCreated` (admin, candidates, window, ballot mode), `VoterRegistered`, `PhaseChanged`, `Voted`, `VoteCommitted`, `Finalized`, `AdminTransferStarted`, `AdminTransferred`, and `AllowlistSet`.

## Architecture
- Reads go **directly from the browser to the node** over HTTP or WebSocket, with no wallet in the path.
- Writes are **simulated with `eth_call` before the wallet is asked to sign**.
- The deployment address is loaded at runtime from `/deployment.json`.
- `web/src/chain/runtime.tsx` holds the clients, health checks, and event watching; `tx.ts` the transaction state machine; `errors.ts` `decodeError`. Raw error strings are never shown to users (F-04).
- `scripts/dev.ts` builds the contract, generates typed ABIs, starts Anvil, deploys, seeds, writes `web/public/deployment.json`, and starts the app.

## Core scenarios
Twelve core voting scenarios are automated Foundry tests in `CoreScenariosTest`:

| No. | Test | Enforced by |
|---|---|---|
| 1 | `test_S01_createWithThreeCandidates` | `createElection`, `ElectionCreated` |
| 2 | `test_S02_nonAdminCannotRegister` | `NotAdmin` |
| 3 | `test_S03_emptyCandidateListReverts` | `CandidateCountOutOfRange` (minimum is 2) |
| 4 | `test_S04_registerVoter` | `registerVoter`, `VoterRegistered`, `getVoters` |
| 5 | `test_S05_doubleRegistrationReverts` | `AlreadyRegistered` |
| 6 | `test_S06_bulkSkipsRepeat` | `registerVoters` |
| 7 | `test_S07_voteOnce` | `vote`, `Voted` |
| 8 | `test_S08_doubleVoteReverts` | `AlreadyVoted` |
| 9 | `test_S09_unregisteredVoteReverts` | `NotRegistered` |
| 10 | `test_S10_invalidCandidateReverts` | `InvalidCandidate` |
| 11 | `test_S11_nonexistentElectionReverts` | `ElectionNotFound` |
| 12 | `test_S12_registrationIsPerElection` | `NotRegistered` |

In total there are 111 Foundry tests, including fuzz tests (one over electorates of 2–2,000 allowlisted addresses) and 6 invariants: tallies sum to the total, no double votes, secret-ballot commit/reveal rules, the allowlist admits only listed addresses, phases never go backwards, and finalize only after Ended. Coverage is 100% of lines, statements, branches, and functions. Browser tests pass on Chrome, WebKit, Pixel 7 and iPhone 14, and a scripted lifecycle run checks 49 assertions. See [VERIFICATION.md](VERIFICATION.md).

## Screenshots
`docs/screenshots/`: `ledger.png`, `election.png`, `lifecycle.png`, `admin.png`, `audit.png`, `result.png`, `secret-ballot.png`, `allowlist.png`, `mobile-ledger.png`.

## Change rounds
1. **Base release:** per-election admins, phases and windows, finalize, validation, read-only app, transaction lifecycle UI, curated errors, one-command dev.
2. **Secret ballots:** commit–reveal with a Reveal phase. Trade-offs are documented: choices become public at reveal, unrevealed votes don't count, and late revealers can selectively abort.
3. **Second audit round** (AUDIT.md §3): two-step admin hand-over, Merkle-root allowlist, wallet-recoverable secret-ballot receipts, EIP-6963 wallet chooser, safe handling of replaced transactions, zero layout shift on mobile, and cross-browser E2E.

## Future work
- zero-knowledge ballot secrecy (secrecy that survives the count)
- identity verification
- public testnet or L2 deployment
- a professional audit
- an indexer for long-lived public deployments
- a forfeitable deposit to discourage selective abort in the Reveal phase
