# Security notes

This covers the contract `contracts/src/Ostrakon.sol` and the trust model of the app as a whole.

## Threat model and trust assumptions

| Actor | Can | Cannot |
|---|---|---|
| Election admin | Choose candidates (once, at creation), decide who is eligible (direct registration and/or a Merkle allowlist root, Registration only), advance phases (unless a schedule is set), nominate a successor | Change candidates, remove a voter, register voters or change the allowlist after Registration, move a phase backwards, cut a scheduled window short, change or delete a vote, alter tallies, hand the election to an address that doesn't accept |
| Registered voter | Cast exactly one vote while the election is in Voting. Secret ballot: seal exactly one commitment during Voting and reveal it once during Reveal | Vote twice, vote outside Voting, vote in another election they aren't registered for, reveal a choice different from the one sealed, reveal someone else's commitment |
| Allowlisted address | Register itself with a Merkle proof during Registration or Voting (alone, or in the same transaction as its vote) | Register another address, register without a valid proof against the current root, register after voting closes |
| Anyone | Read everything, create their own elections, `finalize` an Ended election, `syncPhase` | Act as admin of someone else's election |
| Block producer | Shift `block.timestamp` by a few seconds and reorder or censor transactions | Forge signatures or change contract rules |

**What the design does not provide. The README states these too:**
1. **No lasting ballot secrecy.**
   - *Open ballot:* the candidate index is visible in every `vote` transaction's calldata and in the `Voted` event. Anyone can link an address to its choice. Dropping the event field would hide nothing, because calldata is public, so the event keeps it.
   - *Secret ballot (commit–reveal):* choices are hidden only until each voter reveals; after that they are exactly as public as an open ballot. See "Commit–reveal" below for what the mode does and doesn't buy.
2. **No identity binding.** Eligibility is "the admin put this address on the list." The admin can register addresses they control (Sybil), including their own. Nothing on chain ties an address to a person.
3. **No coercion resistance.** A voter can prove how they voted by pointing at their transaction.
4. **Censorship.** A block producer or RPC provider could delay or drop vote transactions. A scheduled `votingEnd` makes such a delay decisive near the deadline.
5. **Voter list is public.** `getVoters` is a public view, and the same list is derivable from `VoterRegistered` events. An allowlist's full list is whatever file the admin publishes; only claimed members appear on chain.

## Design decisions with security impact

- **Per-election admin instead of a global owner** (fixes AUDIT C-06). Compromising one admin key affects only that admin's elections.
- **Two-step admin hand-over.** `transferAdmin` only nominates (`AdminTransferStarted`). The nominee must call `acceptAdmin`, and until then the current admin keeps full control and can `cancelAdminTransfer` or nominate someone else. A mistyped or unreachable address can therefore never take or strand an election. This replaced the earlier single-step transfer; tests: `TwoStepAdminTest` (8). Mutant "transfer completes in one step" caught by 5 tests.
  - A lost admin key can still stall an unscheduled election in Voting (no one else can advance it), but can't corrupt it, and `finalize` is permissionless. Mitigation: set a `votingEnd` schedule.
- **Forward-only phases.** `storedPhase` only increases. The effective phase is `max(storedPhase, schedulePhase)`, and time only moves forward, so the effective phase never decreases.
  - Proven by `invariant_phaseMonotonic`. A mutant that set `Voting → Registration` was caught (see VERIFICATION.md).
- **Schedules are binding.** When `votingStart` or `votingEnd` is set, the admin can't open or close early (`ScheduleNotReached`). A published schedule is a commitment voters can rely on.
- **Lazy phase recording.** Schedule-driven transitions take effect immediately in every read and check. The `PhaseChanged` event is emitted (with `byTimestamp = true`) by the first state-changing call afterwards, or by anyone calling `syncPhase`. Audit-trail consumers should treat the schedule plus `PhaseChanged` together as the record.
- **No external calls, no ether.** No reentrancy surface. Nothing is payable. Slither found no reentrancy or arbitrary-send issues. Checked directly: a scan of the deployed bytecode finds **no** `CALL`, `CALLCODE`, `DELEGATECALL`, `STATICCALL`, `CREATE`, `CREATE2` or `SELFDESTRUCT` opcodes (OpenZeppelin `MerkleProof` is an internal library, inlined).
- **Bounded loops.**
  - `createElection` makes O(n²) duplicate checks with n ≤ 32.
  - `registerVoters` is capped at `MAX_BATCH = 200`.
  - `finalize` loops over at most 32 tallies.
  - Paginated views are capped at `MAX_PAGE = 100`.
- **Unchecked increments in `vote`, `commitVote`, `revealVote`.** `tallies[i]`, `totalVotes`, and `committed` (uint64) can't overflow in practice. Each increment requires a distinct registered address, and registering costs about 47k gas each, so 2⁶⁴ registrations is infeasible.
  - `invariant_talliesSumToTotal` and `invariant_secretBallot` also check the arithmetic.

### Merkle allowlist
- **Format.** OpenZeppelin `StandardMerkleTree` over `["address"]`: leaf = `keccak256(bytes.concat(keccak256(abi.encode(voter))))`, sorted-pair internal nodes, verified with OZ `MerkleProof.verifyCalldata`. The double hash keeps a 64-byte internal node from ever being accepted as a leaf (second-preimage). The leaf is always built from `msg.sender`, so a proof only ever registers the caller: a stolen proof is useless to anyone else (`test_badProofsRejected`, `testFuzz_largeElectorate` over 2–2,000 members, `invariant_allowlistOnlyListed`). Mutant "proof not verified" caught by 3 unit/fuzz tests and the invariant.
- **Frozen at voting.** `setAllowlist` works only in Registration, so the electorate can't be changed after early results are visible. Members can still claim their place during Voting (with their vote), which adds them to `voterCount` then.
- **Trust.** The root is the admin's word, exactly like direct registration: the admin could include addresses they control. The list file is published off chain; the app accepts a file only if it parses as a valid tree (`tree.validate()` recomputes every hash) **and** its root equals the on-chain root, so a tampered or wrong file is refused before any proof is built (E2E: "tampered list is refused").
- **Privacy of fetching.** The admin's link (`AllowlistSet.uri`) is fetched only when the voter presses "Load the list from the admin's link", with credentials omitted and a 15 s timeout, so merely visiting the election doesn't contact the admin's server. Files over 5 MB are refused. Non-HTTP links (e.g. `ipfs://`) are shown, not fetched.

### Commit–reveal (secret ballot mode)
- **Commitment format:** `keccak256(abi.encode(block.chainid, address(this), electionId, voter, candidateIndex, salt))`.
  - Binding the chain, contract, election, and voter means a copied commitment can't be revealed by another voter (`test_copiedCommitmentCannotBeRevealedByAnotherVoter`), in another election (`test_commitmentIsBoundToElection`), or on another deployment.
  - `abi.encode` (not `encodePacked`) avoids ambiguous concatenation.
- **The choice never leaves the browser before reveal.**
  - The salt comes from `crypto.getRandomValues` (32 bytes), and the commitment is computed locally (`commitmentHash` in `reads.ts`).
  - The contract deliberately has no view that computes a commitment, because calling it through a node would disclose the choice to that node.
  - Only the hash goes into the transaction, the wallet prompt, and the pre-send simulation.
- **Wallet-recoverable receipts (default).** The salt is `keccak256(signature)` over a fixed, election-specific message (`recoveryMessage` in `web/src/lib/recovery.ts`). Standard wallets sign deterministically (RFC 6979), so signing again later reproduces the salt; the choice is then found by trying each candidate (≤ 32) against the on-chain commitment. E2E wipes the stored receipt and recovers it.
  - **Risk:** anyone who obtains that signature (e.g. a phishing site asking you to sign the identical message) can compute your choice before you reveal. They still can't change or reveal your vote. The message says so and tells users to sign it only on Ostrakon.
  - Wallets that don't sign deterministically (some smart-contract wallets) produce a salt that can't be reproduced; recovery then fails safely with an explanation, and the receipt file still works. Declining the signature falls back to a random salt (E2E-tested).
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
| `voteWithProof` (claim + vote, small tree) | 157,811 |
| `setAllowlist` (root + short link) | 77,707 |
| `transferAdmin` (nominate) / `acceptAdmin` | 50,489 / 35,982 |
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
INFO:Slither:. analyzed (3 contracts with 102 detectors), 3 result(s) found
```
(The three contracts are `Ostrakon`, OpenZeppelin's `MerkleProof`, and its `Hashes` helper.)

| # | Detector | Location | Triage |
|---|---|---|---|
| S-1 | `timestamp` | `_create`, `Ostrakon.sol:610`: `votingEnd <= block.timestamp` | **Accepted.** Validators can skew timestamps by seconds. A schedule end a few seconds in the future could be accepted or rejected near the boundary. The only effect is the creator retrying. No funds or tallies are affected. |
| S-2 | `timestamp` | `_effectivePhase`, `Ostrakon.sol:653,657,661` (reveal end, voting end, voting start) | **Accepted, by design.** Timestamp windows are a requirement. A block producer can open or close a window a few seconds early or late. The README and How-it-works screen say schedules are accurate to roughly one block. Don't use schedules where seconds matter. |
| S-3 | `cyclomatic-complexity` (13) | `_create` | **Accepted.** The complexity is the input validation itself: name, count, per-candidate emptiness, length, duplicates, schedule. Each branch has its own test (`CreateValidationTest`, `test_secretScheduleValidation`, fuzz `testFuzz_nameLengths`). Coverage shows 100% of branches. |

### forge lint (`npm run lint:sol` runs `forge lint -D warnings`, so any warning fails)

| Lint | Where | Triage |
|---|---|---|
| `block-timestamp` ×4 | same as S-1, S-2 | Accepted, see above. Suppressed inline with the reason, so the strict gate stays meaningful. |
| `require-revert-in-loop` ×3 | duplicate, empty, and too-long candidate checks in `createElection` | **Accepted.** Reverting on the first invalid candidate is the intended behavior. The loop is bounded (≤ 32). Suppressed inline with the reason. |
| `unsafe-typecast` ×2 | `uint64(block.number)`, `uint8(bestIdx)` | **Suppressed with justification inline.** The block number fits in 64 bits. `bestIdx < 32`. |
| `uninitialized-local` ×3 | loop counters | **Fixed:** counters are now initialized explicitly. |
| `reentrancy-events` ×4 | events in `_setPhase`, `_vote`, `revealVote`, `_commit`, `_register` | **False positive, suppressed inline with the reason.** forge-lint treats the `MerkleProof` library call as an external call. It is an `internal pure` function compiled inline: the deployed bytecode contains no `CALL`-family or `CREATE` opcodes at all (opcode scan of `contracts/out/Ostrakon.sol/Ostrakon.json`), so nothing can re-enter. Slither, which models library calls, reports no reentrancy. |

## Test-based assurance

- 110 unit and fuzz tests (22 for the secret ballot, 14 for the allowlist, 8 for the two-step hand-over) plus one invariant suite with 6 invariants (forge reports 111 tests). 100% line, statement, branch, and function coverage on `Ostrakon.sol`. See VERIFICATION.md for the run.
- Invariants run 256 runs × depth 64 by default (`profile.ci`: 1024 × 128) over four elections (open/manual, open/scheduled, secret, open with an allowlist and no direct registrations):
  - sum of tallies = `totalVotes` = number of successful `vote` or `revealVote` calls, and `totalVotes ≤ voterCount`
  - open ballots: no address ever has more than one successful vote; `hasVoted` agrees with history; only registered addresses voted
  - secret ballot: at most one commitment and one reveal per voter; reveals only follow commitments; `totalVotes ≤ committed ≤ voterCount`; a reveal with a wrong salt is never accepted; open ballots never record commitments
  - allowlist: only listed addresses are ever registered in the allowlist-only election, an outsider's claim (using a member's proof) is never accepted, and registrations never exceed the list size
  - the effective phase never decreases, and open ballots never enter Reveal
  - finalization only happens in Ended, and a finalized election stays Ended
- Mutation checks: eight hand-made mutants are each caught by at least one invariant or unit test:
  - remove the double-vote check
  - miscount tallies
  - hide Ended
  - let a phase go backwards
  - skip the commitment hash check
  - allow a second reveal
  - skip the Merkle proof check
  - complete the admin transfer in one step

  Details in VERIFICATION.md.

## Frontend security rules
- Raw errors, revert data, and stack traces are never rendered. `decodeError` maps custom-error **names** from the typed ABI to curated text. Anything unknown gets a generic message. Raw errors go to `console.error` only.
- Every write is simulated (`eth_call`) before the wallet is asked to sign, so predictable reverts never reach the wallet.
- The test-only wallet connector is compiled in only when `VITE_E2E=1`. VERIFICATION.md shows the production bundle doesn't contain it.
- Deployment info is validated at runtime: the expected chain id, and that code exists at the address. The app explains a stale or missing deployment instead of failing silently.
- Transactions a wallet replaces are judged by viem's replacement reason: only a "repriced" (sped-up, same call) replacement counts as the user's action; "cancelled" or "replaced" with a different call is reported as not having happened, never as success. Waiting for a receipt times out after 3 minutes with curated copy telling the user to check the audit trail before retrying (so they don't double-submit).
- With several wallets installed, EIP-6963 announcements are offered by name, instead of trusting whichever extension won `window.ethereum`.

## Not done, and why
- **Secrecy after reveal / ZK ballots:** out of scope. Commit–reveal is the implemented stretch goal; see its weaknesses above.
- **Selective-abort deterrent** (a deposit forfeited by unrevealed voters): not implemented, because the contract deliberately holds no ether.
- **External audit:** none. This is a teaching and portfolio project, and it is **not suitable for binding elections**.
