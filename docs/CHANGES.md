# What changed from the reference project, by report section

This maps every change Ostrakon makes against the reference project to the section of the *Mini Project Report* that would need updating. Defect IDs (A-, C-, F-) refer to [AUDIT.md](AUDIT.md).

## Abstract
- "The contract lets an election administrator, who is the owner of the contract, create elections…" → **Anyone can create an election and becomes *that election's* admin.** There is no global owner (C-06).
- "the contract has no election phases or closing time" → **Phases are Registration → Voting → Ended, forward-only, with optional binding timestamps.** `finalize` records a winner or a tie on chain (C-01, C-02).
- "A web frontend built with React, React Router and the web3.js library connects … through the MetaMask wallet" → **The web app uses React 19 + TypeScript + Vite, viem, and wagmi.** It reads the chain **without a wallet**; a wallet is only needed to send transactions (F-01).
- "It outlines extensions such as election phases, commit–reveal voting and zero-knowledge proofs" → **phases and commit–reveal are implemented.** Each election is an open ballot or a **secret ballot**, in which voters seal a hash of their choice and reveal it in an extra Reveal phase. ZK proofs remain future work.
- Keywords: replace Hardhat → **Foundry (forge, anvil)**, web3.js → **viem/wagmi**. Add *commit–reveal, Slither, fuzz testing, invariant testing*.

## 1. Introduction
- The three parts stay, with these changes:
  - Smart contract: `Voting.sol` → `Ostrakon.sol`
  - Web frontend: four pages → six screens (Ledger, Election, Manage, New election, Audit, How it works) plus a persistent network bar
  - Wallet integration: any EIP-1193 or EIP-6963 browser wallet, not only MetaMask
- "The Voting Booth … refreshes them every six seconds" → **Updates are event-driven.** The contract's events are watched over WebSocket, with log polling as fallback. All tallies come from one `getTallies` call instead of one call per candidate (F-06).
- The sample election table (Ananya / Rahul / Sneha) is now **seeded automatically** as "Student Council 2026" by `npm run dev`, together with five other elections in other phases, including a secret ballot.
- The paragraph on what the design does and doesn't provide needs one change. For open ballots it still holds: no ballot secrecy. Secret ballots hide choices until each voter reveals; after that they are public too. Eligibility is still the admin's word. Ostrakon states all of this in the UI (How it works, the vote confirmation, the audit page) and in the README.

## 2. Objectives
Add:
- 9. Enforce an election lifecycle (phases and timestamp windows) in contract code.
- 10. Verify the contract with unit, fuzz, and invariant tests and static analysis, and run the whole app end to end in a browser.
- 11. Make the audit trail and each voter's own vote verifiable from chain logs.

Objective 6 (local Hardhat blockchain) → local **Anvil** chain, started by one command.

## 3. Problem statement
Still accurate. You could add: "…and the election's phases and closing time must also be enforced by code rather than by the administrator."

## 4. Literature survey
- §4.5 Security of smart contracts: "uses an onlyOwner modifier" → **a per-election admin check** (`NotAdmin` custom error). Add that Ostrakon uses **custom errors**, **no external calls**, **bounded loops** (≤ 32 candidates, ≤ 200 addresses per batch), and was checked with **Slither 0.11.6** (3 informational findings, all triaged in SECURITY.md).
- §4.6 comparison table:
  - *Voter identity*: "Wallet address registered by the owner" → "…registered by the election's admin".
  - Add a row *Election lifecycle*: centralized = operator decides; this project = **contract-enforced phases and windows**.

## 5. Requirement specification
**§5.2 Software:**

| Report | Ostrakon |
|---|---|
| Solidity 0.8.9 | Solidity 0.8.30 (`pragma ^0.8.24`) |
| Hardhat + hardhat-toolbox (ethers v5) | Foundry 1.8 (forge, anvil, cast) |
| React 17 (react-scripts), React Router 6 | React 19, Vite 8, React Router 8, TypeScript 6 |
| web3.js 1.10 | viem 2 + wagmi 3 + TanStack Query 5 |
| Hardhat network, chain id 1337 | Anvil, chain id **31337** |
| (none) | Playwright (E2E), Vitest (unit), Slither (static analysis) |

**§5.3 Functional requirements:**
1. "The administrator (contract owner) can create an election … at least one candidate" → **anyone** can create one; **2–32 unique, non-empty candidates** of ≤ 64 bytes each; a name of ≤ 80 bytes; an optional voting window.
2. "…register voter addresses … one at a time or in bulk, and can view the list" → registration happens **only during Registration**; bulk is capped at 200 per transaction (the UI splits longer lists automatically); the list is **public** (C-07).
3. Add: the admin advances the phase. A set window binds the admin too.
4. Unchanged, plus: votes only during Voting.
5. "Anyone can view…" → now true **without a wallet** (F-01).
6. "…shows the Admin Dashboard only to the owner" → each election's **Manage** screen is shown only to that election's admin.
7. Add: anyone can **finalize** an ended election; the result (winner or tie) is stored and emitted.
8. Add: anyone can verify their own vote from the `Voted` event (Audit → Verify my vote).
9. Add: the creator chooses an **open or secret ballot**. In a secret ballot a registered voter seals one commitment during Voting and reveals it during Reveal; only revealed votes are counted.
10. Add: for large electorates the admin can publish a **Merkle-root allowlist** instead of registering every address; listed voters register themselves with a proof (during Registration, or in the same transaction as their vote). The list is frozen when voting opens.
11. Add: the admin role is handed over in **two steps** (nominate, then the nominee accepts; the admin can cancel).

## 6. Implementation
**§6.1 Architecture.** Replace Figure 1 with the README diagram. Differences from the original:
- Reads go **directly from the browser to the node** over HTTP or WebSocket, with no wallet in the path.
- Writes are **simulated with `eth_call` before the wallet is asked to sign**.
- The deployment address is loaded at runtime from `/deployment.json`.

**§6.2 Roles and contract rules:**

| Role | Functions | Enforced by |
|---|---|---|
| Anyone | `createElection`, `createSecretElection`, `finalize`, `syncPhase`, all views | none (after `finalize`: phase must be Ended) |
| Election admin | `registerVoter`, `registerVoters`, `setAllowlist`, `advancePhase`, `transferAdmin`, `cancelAdminTransfer` | `onlyAdmin(electionId)` → `NotAdmin` |
| Nominated admin | `acceptAdmin` | `pendingAdmin == msg.sender` → `NotPendingAdmin` |
| Allowlisted address | `registerWithProof`, `voteWithProof`, `commitVoteWithProof` | Merkle proof of `msg.sender` against the stored root → `NotOnAllowlist` |
| Registered voter (secret ballot) | `commitVote(electionId, commitment)` in Voting, `revealVote(electionId, candidateIndex, salt)` in Reveal | phase, `registered`, one commitment, commitment must match on reveal |
| Registered voter | `vote(electionId, candidateIndex)` | phase == Voting, `registered`, `!voted` |

The struct now also holds `admin`, `votingStart`, `votingEnd`, `storedPhase`, `finalized`, `tie`, `winner`, `createdBlock`, `totalVotes`, and `tallies[]` (an array replacing the `votesPerCandidate` mapping, so all tallies are one read). `exists` is gone: an id is valid when `1 ≤ id ≤ electionCount`.

There are nine events (three before): `AdminTransferStarted` and `AllowlistSet` are new in the latest round, alongside `ElectionCreated` (now includes admin, candidates, the window, and the ballot mode), `VoterRegistered`, `PhaseChanged` (new), `Voted`, `VoteCommitted` (new, secret ballot), `Finalized` (new), and `AdminTransferred` (new).

**§6.3 Contract listing.** Replace with `contracts/src/Ostrakon.sol`. Main differences:
- custom errors
- NatSpec
- validation of every input
- no redundant existence checks (C-11)
- no zero writes
- views `getElections`, `getTallies`, `getVoterStatuses`, `isRegistered`, `hasVoted`, `voterCount`, and paginated `getVoters`

**§6.4 Frontend.** Replace the `Web3Context` listing with `web/src/chain/runtime.tsx` (clients, health checks, event watching), `tx.ts` (the transaction state machine), and `errors.ts` (`decodeError`).
- Raw error strings are no longer shown to users (F-04).
- The double provider and listener leak are gone (F-02, F-03).

**§6.5 Local blockchain and deployment script.** Replace with `scripts/dev.ts`:
- One command builds the contract, generates typed ABIs, starts Anvil, deploys, seeds, writes `web/public/deployment.json`, and starts the app.
- Account #0 deploys. There is no global admin to get wrong (A-06).
- Artifacts no longer live in a tool-managed folder (A-02).

**§6.6 Deployment and running steps.** Replace steps 2–8 with:
1. Install Foundry, then `npm install`.
2. `npm run dev`.
3. Open http://localhost:5173. Everything is readable straight away.
4. To act: `npm run keys`, import a printed test key into a browser wallet, and press **Connect wallet**. The app offers to add or switch to the Anvil network.

**§6.7 Test scenarios.** All 12 scenarios are now automated Foundry tests. Expected results now name custom errors, and the old revert-string column becomes:

| No. | Ostrakon test | Enforced by |
|---|---|---|
| 1 | `test_R01_createWithThreeCandidates` | `createElection`, `ElectionCreated` |
| 2 | `test_R02_nonAdminCannotRegister` | `NotAdmin` (create is open to anyone by design) |
| 3 | `test_R03_emptyCandidateListReverts` | `CandidateCountOutOfRange` (minimum is now 2) |
| 4 | `test_R04_registerVoter` | `registerVoter`, `VoterRegistered`, `getVoters` |
| 5 | `test_R05_doubleRegistrationReverts` | `AlreadyRegistered` |
| 6 | `test_R06_bulkSkipsRepeat` | `registerVoters` |
| 7 | `test_R07_voteOnce` | `vote`, `Voted` |
| 8 | `test_R08_doubleVoteReverts` | `AlreadyVoted` |
| 9 | `test_R09_unregisteredVoteReverts` | `NotRegistered` |
| 10 | `test_R10_invalidCandidateReverts` | `InvalidCandidate` |
| 11 | `test_R11_nonexistentElectionReverts` | `ElectionNotFound` |
| 12 | `test_R12_registrationIsPerElection` | `NotRegistered` |

Add a paragraph: 111 Foundry tests in total, including fuzz tests (one over electorates of 2–2,000 allowlisted addresses) and 6 invariants (tallies sum to the total, no double votes, secret-ballot commit/reveal rules, allowlist admits only listed addresses, phases never go backwards, finalize only after Ended). Coverage is 100% of lines, statements, branches, and functions. There are also 22 browser tests passing on Chrome, WebKit, Pixel 7 and iPhone 14 (plus a touch-only test on the two phones) and a 49-assertion scripted lifecycle run. See VERIFICATION.md.

## 7. Snapshots
Replace Figures 3–6 with `docs/screenshots/`: `ledger.png`, `election.png`, `lifecycle.png`, `admin.png`, `audit.png`, `result.png`, `secret-ballot.png`, `allowlist.png`, `mobile-ledger.png`. Figure 2 (node running) can be replaced with the `npm run dev` console output, which lists the deployed address and the demo accounts and their roles.

## 8. Conclusion and future scope
Now implemented:
- "Election phases (Registration, Voting, Ended) and time windows enforced by block timestamps, with an on-chain winner function"
- "Commit–reveal voting", as an optional secret-ballot mode with its own Reveal phase. Its trade-offs are documented: choices become public at reveal, unrevealed votes don't count, and late revealers can selectively abort.
- "Complete automated contract tests"
- "gas optimisation of bulk registration", answered more fundamentally: a **Merkle-root allowlist** lets one transaction define an electorate of any size

Also implemented beyond the report: **two-step admin hand-over** and **wallet-recoverable secret-ballot receipts**.

Still future work, carried over:
- zero-knowledge ballot secrecy (secrecy that survives the count)
- identity verification
- public testnet or L2 deployment
- a professional audit

New future work:
- an indexer for long-lived public deployments
- a forfeitable deposit to discourage selective abort in the Reveal phase

The paragraph on limits stays accurate. Update "the owner-only voter list can also be reconstructed from the public registration events": in Ostrakon the voter list is simply **public**, and the app says so.

## 9. SDG goals
No change.

## 10. References
Replace [10] web3.js with viem (https://viem.sh) and wagmi (https://wagmi.sh), and [12] Hardhat with Foundry (https://getfoundry.sh). Add Slither (https://github.com/crytic/slither) and Playwright (https://playwright.dev).
