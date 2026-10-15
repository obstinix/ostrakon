# Security notes

This covers the contract `contracts/src/Ostrakon.sol` and the trust model of the app as a whole.

## Threat model and trust assumptions

| Actor | Can | Cannot |
|---|---|---|
| Election admin | Choose candidates (once, at creation), decide who is eligible, advance phases (unless a schedule is set), transfer the admin role | Change candidates, remove a voter, register voters after Registration, move a phase backwards, cut a scheduled window short, change or delete a vote, alter tallies |
| Registered voter | Cast exactly one vote while the election is in Voting | Vote twice, vote outside Voting, vote in another election they aren't registered for |
| Anyone | Read everything, create their own elections, `finalize` an Ended election, `syncPhase` | Act as admin of someone else's election |
| Block producer | Shift `block.timestamp` by a few seconds and reorder or censor transactions | Forge signatures or change contract rules |

**What the base design does not provide. The README states these too:**
1. **No ballot secrecy.** The candidate index is visible in every `vote` transaction's calldata and in the `Voted` event. Anyone can link an address to its choice. Dropping the event field would hide nothing, because calldata is public. That's why the event keeps it.
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
- **Unchecked increments in `vote`.** `tallies[i]` and `totalVotes` (uint64) can't overflow in practice. Each increment requires a distinct registered address, and registering costs about 47k gas each, so 2⁶⁴ registrations is infeasible.
  - `invariant_talliesSumToTotal` also checks the arithmetic.

### Measured costs (forge, optimizer 10,000 runs, solc 0.8.30)

| Call | Gas |
|---|---|
| `vote` (first vote, cold slots) | 82,676 |
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
| S-1 | `timestamp` | `createElection`, `Ostrakon.sol:162`: `votingEnd <= block.timestamp` | **Accepted.** Validators can skew timestamps by seconds. A schedule end a few seconds in the future could be accepted or rejected near the boundary. The only effect is the creator retrying. No funds or tallies are affected. |
| S-2 | `timestamp` | `_effectivePhase`, `Ostrakon.sol:400,404` | **Accepted, by design.** Timestamp windows are a requirement. A block producer can open or close a window a few seconds early or late. The README and How-it-works screen say schedules are accurate to roughly one block. Don't use schedules where seconds matter. |
| S-3 | `cyclomatic-complexity` (13) | `createElection` | **Accepted.** The complexity is the input validation itself: name, count, per-candidate emptiness, length, duplicates, schedule. Each branch has its own test (`CreateValidationTest`, fuzz `testFuzz_nameLengths`). Coverage shows 100% of branches. |

### forge lint (`npm run lint:sol` runs `forge lint -D warnings`, so any warning fails)

| Lint | Where | Triage |
|---|---|---|
| `block-timestamp` ×3 | same as S-1, S-2 | Accepted, see above. Suppressed inline with the reason, so the strict gate stays meaningful. |
| `require-revert-in-loop` ×3 | duplicate, empty, and too-long candidate checks in `createElection` | **Accepted.** Reverting on the first invalid candidate is the intended behavior. The loop is bounded (≤ 32). Suppressed inline with the reason. |
| `unsafe-typecast` ×2 | `uint64(block.number)`, `uint8(bestIdx)` | **Suppressed with justification inline.** The block number fits in 64 bits. `bestIdx < 32`. |
| `uninitialized-local` ×3 | loop counters | **Fixed:** counters are now initialized explicitly. |

## Test-based assurance

- 66 unit and fuzz tests plus one invariant suite with 4 invariants (forge reports 67 tests). 100% line, statement, branch, and function coverage on `Ostrakon.sol`. See VERIFICATION.md for the run.
- Invariants run 256 runs × depth 64 by default (`profile.ci`: 1024 × 128):
  - sum of tallies = `totalVotes` = number of successful `vote` calls, and `totalVotes ≤ voterCount`
  - no address ever has more than one successful vote; `hasVoted` agrees with history; only registered addresses voted
  - the effective phase never decreases
  - finalization only happens in Ended, and a finalized election stays Ended
- Mutation checks: four hand-made mutants (remove the double-vote check, miscount tallies, hide Ended, let a phase go backwards). Every one is caught by at least one invariant or unit test. Details in VERIFICATION.md.

## Frontend security rules
- Raw errors, revert data, and stack traces are never rendered. `decodeError` maps custom-error **names** from the typed ABI to curated text. Anything unknown gets a generic message. Raw errors go to `console.error` only.
- Every write is simulated (`eth_call`) before the wallet is asked to sign, so predictable reverts never reach the wallet.
- The test-only wallet connector is compiled in only when `VITE_E2E=1`. VERIFICATION.md shows the production bundle doesn't contain it.
- Deployment info is validated at runtime: the expected chain id, and that code exists at the address. The app explains a stale or missing deployment instead of failing silently.

## Not done, and why
- **Commit–reveal mode:** a stretch goal, not in this version. See README "Future scope".
- **Merkle-root allowlist:** deferred. The prompt allows it only after the base allowlist is complete. The base allowlist is complete and tested, but I put the remaining time into the end-to-end app.
- **External audit:** none. This is a teaching and portfolio project, and it is **not suitable for binding elections**.
