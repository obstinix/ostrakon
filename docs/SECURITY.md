# Security notes

This covers the contract `contracts/src/Ostrakon.sol` and the trust model of the app as a whole.

## Threat model and trust assumptions

| Actor | Can | Cannot |
|---|---|---|
| Election admin | Choose candidates (once, at creation), decide who is eligible, advance phases (unless a schedule is set), transfer the admin role | Change candidates, remove a voter, register voters after Registration, move a phase backwards, cut a scheduled window short, change or delete a vote, alter tallies |
| Registered voter | Cast exactly one vote while the election is in Voting. Secret ballot: seal exactly one commitment during Voting and reveal it once during Reveal | Vote twice, vote outside Voting, vote in another election they aren't registered for, reveal a choice different from the one sealed, reveal someone else's commitment |
| Anyone | Read everything, create their own elections, `finalize` an Ended election, `syncPhase` | Act as admin of someone else's election |
| Block producer | Shift `block.timestamp` by a few seconds and reorder or censor transactions | Forge signatures or change contract rules |

**What the design does not provide. The README states these too:**
1. **No lasting ballot secrecy.**
   - *Open ballot:* the candidate index is visible in every `vote` transaction's calldata and in the `Voted` event. Anyone can link an address to its choice. Dropping the event field would hide nothing, because calldata is public, so the event keeps it.
   - *Secret ballot (commit–reveal):* choices are hidden only until each voter reveals; after that they are exactly as public as an open ballot. See "Commit–reveal" below for what the mode does and doesn't buy.
2. **No identity binding.** Eligibility is "the admin put this address on the list." The admin can register addresses they control (Sybil), including their own. Nothing on chain ties an address to a person.
3. **No coercion resistance.** A voter can prove how they voted by pointing at their transaction.
4. **Censorship.** A block producer or RPC provider could delay or drop vote transactions. A scheduled `votingEnd` makes such a delay decisive near the deadline.
5. **Voter list is public.** `getVoters` is a public view, and the same list is derivable from `VoterRegistered` events.

## Design decisions with security impact

- **Per-election admin instead of a global owner** (fixes AUDIT C-06). Compromising one admin key affects only that admin's elections. `transferAdmin` lets an admin rotate a key.
  - Transfer is single-step with a zero-address check. A typo in the new address loses admin control of that election. Two-step (propose then accept) would remove that risk at the cost of a second transaction. The admin powers that remain after Registration are limited (advance phase, transfer), and finalize is permissionless. So a lost admin can stall an unscheduled election in Voting, but can't corrupt it.
  - Mitigation for that stall: set a `votingEnd` schedule. The election then ends without the admin.
- **Forward-only phases.** `storedPhase` only increases. The effective phase is `max(storedPhase, schedulePhase)`, and time only moves forward, so the effective phase never decreases.
  - Proven by `invariant_phaseMonotonic`. A mutant that set `Voting → Registration` was caught (see VERIFICATION.md).
- **Schedules are binding.** When `votingStart` or `votingEnd` is set, the admin can't open or close early (`ScheduleNotReached`). A published schedule is a commitment voters can rely on.
- **Lazy phase recording.** Schedule-driven transitions take effect immediately in every read and check. The `PhaseChanged` event is emitted (with `byTimestamp = true`) by the first state-changing call afterwards, or by anyone calling `syncPhase`. Audit-trail consumers should treat the schedule plus `PhaseChanged` together as the record.
- **No external calls, no ether.** No reentrancy surface. Nothing is payable. Slither found no reentrancy or arbitrary-send issues.
- **Bounded loops.**
  - `createElection` makes O(n²) duplicate checks with n ≤ 32.
  - `registerVoters` is capped at `MAX_BATCH = 200`.
  - `finalize` loops over at most 32 tallies.
  - Paginated views are capped at `MAX_PAGE = 100`.
- **Unchecked increments in `vote`, `commitVote`, `revealVote`.** `tallies[i]`, `totalVotes`, and `committed` (uint64) can't overflow in practice. Each increment requires a distinct registered address, and registering costs about 47k gas each, so 2⁶⁴ registrations is infeasible.
  - `invariant_talliesSumToTotal` and `invariant_secretBallot` also check the arithmetic.

### Commit–reveal (secret ballot mode)
- **Commitment format:** `keccak256(abi.encode(block.chainid, address(this), electionId, voter, candidateIndex, salt))`.
  - Binding the chain, contract, election, and voter means a copied commitment can't be revealed by another voter (`test_copiedCommitmentCannotBeRevealedByAnotherVoter`), in another election (`test_commitmentIsBoundToElection`), or on another deployment.
  - `abi.encode` (not `encodePacked`) avoids ambiguous concatenation.
- **The choice never leaves the browser before reveal.**
  - The salt comes from `crypto.getRandomValues` (32 bytes), and the commitment is computed locally (`commitmentHash` in `reads.ts`).
  - The contract deliberately has no view that computes a commitment, because calling it through a node would disclose the choice to that node.
  - Only the hash goes into the transaction, the wallet prompt, and the pre-send simulation.
- **Receipts.**
  - The app saves the receipt (choice + salt) in `localStorage` *before* sending the commit, so a closed tab after a successful commit doesn't lose it.
  - It also offers a JSON download.
  - On reveal it checks a stored or pasted receipt against the on-chain commitment before sending, so a wrong receipt is explained instead of reverting.
  - **Risk:** localStorage is readable by any script on the same origin. An XSS bug would expose sealed choices, but that wouldn't let anyone change a vote.
- **Only revealed votes count.** `totalVotes ≤ committed ≤ voterCount` (invariant). A finalized secret ballot reports unrevealed votes in the UI.
- **Known weaknesses of commit–reveal, not mitigated here:**
  - **Selective abort:** during Reveal, running counts are visible, so a voter whose sealed choice is losing can decline to reveal. A forfeitable deposit would discourage this. Not implemented, because this contract holds no ether by design.
  - **Lost receipts:** if both the stored receipt and the downloaded file are lost, the vote can never be counted.
  - **Proof of vote:** a voter can hand someone else their receipt, so there's no coercion resistance.
  - **Two transactions:** voting costs two transactions (commit 83,085 gas; reveal 85,571 gas).
- **Schedules:** a scheduled `revealEnd` requires a scheduled `votingEnd` and must come after it, so no schedule can skip the Reveal window (`test_secretScheduleValidation`). Open ballots never enter Reveal (`invariant_phaseMonotonic`).

### Measured costs (forge, optimizer 10,000 runs, solc 0.8.30)

| Call | Gas |
|---|---|
| `vote` (first vote, cold slots) | 82,676 |
| `commitVote` (secret ballot) | 83,085 |
| `revealVote` (secret ballot) | 85,571 |
| `registerVoters` × 200 (the cap) | 9,472,010 (≈ 47,360 per address) |
| `registerVoter` (median) | 80,551 |
| `createElection` (median, 3 candidates) | 244,631 |
| `createElection` (max seen, 32 candidates) | 1,086,953 |
| `finalize` (median) | 43,285 |

A full batch uses about 32% of a 30M block gas limit. The UI splits longer lists into chunks of at most 200.

## Static analysis

### Slither 0.11.6 (102 detectors)
```
$ slither . --filter-paths "node_modules|contracts/test" --exclude-dependencies
INFO:Slither:. analyzed (1 contracts with 102 detectors), 3 result(s) found
```

| # | Detector | Location | Triage |
|---|---|---|---|
| S-1 | `timestamp` | `_create`, `Ostrakon.sol:487`: `votingEnd <= block.timestamp` | **Accepted.** Validators can skew timestamps by seconds. A schedule end a few seconds in the future could be accepted or rejected near the boundary. The only effect is the creator retrying. No funds or tallies are affected. |
| S-2 | `timestamp` | `_effectivePhase`, `Ostrakon.sol:520,524,528` (reveal end, voting end, voting start) | **Accepted, by design.** Timestamp windows are a requirement. A block producer can open or close a window a few seconds early or late. The README and How-it-works screen say schedules are accurate to roughly one block. Don't use schedules where seconds matter. |
| S-3 | `cyclomatic-complexity` (13) | `_create` | **Accepted.** The complexity is the input validation itself: name, count, per-candidate emptiness, length, duplicates, schedule. Each branch has its own test (`CreateValidationTest`, `test_secretScheduleValidation`, fuzz `testFuzz_nameLengths`). Coverage shows 100% of branches. |

### forge lint (`npm run lint:sol` runs `forge lint -D warnings`, so any warning fails)

| Lint | Where | Triage |
|---|---|---|
| `block-timestamp` ×4 | same as S-1, S-2 | Accepted, see above. Suppressed inline with the reason, so the strict gate stays meaningful. |
| `require-revert-in-loop` ×3 | duplicate, empty, and too-long candidate checks in `createElection` | **Accepted.** Reverting on the first invalid candidate is the intended behavior. The loop is bounded (≤ 32). Suppressed inline with the reason. |
| `unsafe-typecast` ×2 | `uint64(block.number)`, `uint8(bestIdx)` | **Suppressed with justification inline.** The block number fits in 64 bits. `bestIdx < 32`. |
| `uninitialized-local` ×3 | loop counters | **Fixed:** counters are now initialized explicitly. |

## Test-based assurance

- 88 unit and fuzz tests (22 of them for the secret ballot) plus one invariant suite with 5 invariants (forge reports 89 tests). 100% line, statement, branch, and function coverage on `Ostrakon.sol`. See VERIFICATION.md for the run.
- Invariants run 256 runs × depth 64 by default (`profile.ci`: 1024 × 128) over three elections (open/manual, open/scheduled, secret):
  - sum of tallies = `totalVotes` = number of successful `vote` or `revealVote` calls, and `totalVotes ≤ voterCount`
  - open ballots: no address ever has more than one successful vote; `hasVoted` agrees with history; only registered addresses voted
  - secret ballot: at most one commitment and one reveal per voter; reveals only follow commitments; `totalVotes ≤ committed ≤ voterCount`; a reveal with a wrong salt is never accepted; open ballots never record commitments
  - the effective phase never decreases, and open ballots never enter Reveal
  - finalization only happens in Ended, and a finalized election stays Ended
- Mutation checks: six hand-made mutants are each caught by at least one invariant or unit test:
  - remove the double-vote check
  - miscount tallies
  - hide Ended
  - let a phase go backwards
  - skip the commitment hash check
  - allow a second reveal

  Details in VERIFICATION.md.

## Frontend security rules
- Raw errors, revert data, and stack traces are never rendered. `decodeError` maps custom-error **names** from the typed ABI to curated text. Anything unknown gets a generic message. Raw errors go to `console.error` only.
- Every write is simulated (`eth_call`) before the wallet is asked to sign, so predictable reverts never reach the wallet.
- The test-only wallet connector is compiled in only when `VITE_E2E=1`. VERIFICATION.md shows the production bundle doesn't contain it.
- Deployment info is validated at runtime: the expected chain id, and that code exists at the address. The app explains a stale or missing deployment instead of failing silently.

## Not done, and why
- **Secrecy after reveal / ZK ballots:** out of scope. Commit–reveal is the implemented stretch goal; see its weaknesses above.
- **Merkle-root allowlist:** deferred. The prompt allows it only after the base allowlist is complete. The base allowlist is complete and tested, but I put the remaining time into the end-to-end app.
- **External audit:** none. This is a teaching and portfolio project, and it is **not suitable for binding elections**.
