# Verification

Every result below came from running the command shown. Outputs are trimmed to the relevant lines and otherwise unedited.

**Environment:** Windows 11, Node v22.23.1, npm 10.9.8, Foundry 1.8.5 (forge/anvil, SHA-256 of the release zip checked against the published `.sha256`), solc 0.8.30, Chrome (installed) driven by Playwright 1.64.1, Slither 0.11.6.

## 1. Clean clone: install, lint, typecheck, tests, build

Fresh `git clone https://github.com/obstinix/ostrakon` into an empty folder, at commit **`748ccff`**. Before installing, the clone had no `web/src/generated/` and no `deployment.json`: everything is generated.

```
npm ci                 exit=0   (209 packages)
npm run lint           exit=0   (forge fmt --check · forge lint -D warnings · eslint --max-warnings 0)
npm run typecheck      exit=0   (forge build → gen-abi → tsc web + tsc node/scripts/e2e)
npm run test           exit=0
npm run coverage       exit=0
npm run build          exit=0
npm run lifecycle      exit=0
npm run test:e2e       exit=0
npm audit --omit=dev   found 0 vulnerabilities
```

The first clean-clone run found a real bug: `typecheck` failed with `TS2717`, because two E2E specs declared the test-hook `Window` type differently. My working copy hadn't run typecheck since the second spec was added. I fixed it in `748ccff`, and the whole sequence above was then rerun from a new clone.

### Contract tests: unit, fuzz, invariant (`npm run test:contracts`)
```
Suite result: ok. 8 passed   (AccessControlTest)
Suite result: ok. 4 passed   (ViewsTest)
Suite result: ok. 10 passed  (CreateValidationTest)
Suite result: ok. 14 passed  (PhaseTest)
Suite result: ok. 8 passed   (BatchTest)
Suite result: ok. 12 passed  (ReportScenariosTest: the 12 core voting scenarios)
Suite result: ok. 4 passed   (VoteFuzzTest)
Suite result: ok. 6 passed   (FinalizeTest)
[PASS] invariant_finalizeOnlyWhenEnded
[PASS] invariant_noDoubleVote
[PASS] invariant_phaseMonotonic
[PASS] invariant_talliesSumToTotal
Ran 9 test suites in 8.31s: 67 tests passed, 0 failed, 0 skipped (67 total tests)
```
- Fuzz tests run 1,024 times each (`foundry.toml`, fixed seed).
- Invariants run 256 runs × depth 64. Handler call counts: each of `register`, `advance`, `vote`, `warp`, and `finalize` was called about 3,200–3,300 times per campaign.

**Do the invariants actually bite?** I checked by mutation (`contracts/src/Ostrakon.sol` edited, tests run, file restored):

| Mutant | Caught by |
|---|---|
| Delete the `AlreadyVoted` check | `invariant_noDoubleVote` ("voted at most once: 2 > 1"), `invariant_talliesSumToTotal` ("totalVotes <= voterCount: 9 > 8") |
| A vote for candidate 0 also adds one to candidate 1 | `invariant_talliesSumToTotal` ("sum(tallies) == totalVotes: 2 != 1") |
| `advancePhase` sets Voting → Registration | `invariant_phaseMonotonic` ("phase went backwards") |
| Ended is reported as Voting for manual elections | 10 unit tests failed. The invariants didn't catch this one: it hides Ended rather than moving the phase backwards, so it's a liveness bug, not a monotonicity violation. |

After restoring the file: 66/66, then later 67/67 with the added `getVoterStatuses` test.

### Frontend unit tests (`npm run test:web`)
```
 Test Files  2 passed (2)
      Tests  8 passed (8)
```
- `errors.test.ts`: every custom error in the ABI has curated copy. Reverts are mapped by name, with arguments. Raw text (`0xdeadbeef stack at foo.ts:12`) never comes back out. Wallet rejection and network failures are classified.
- `voters.test.ts`: list preview classifies valid, duplicate, already-registered, zero, malformed, and bad-checksum entries. Chunking is checked.

## 2. Coverage, gas, static analysis

```
$ npm run coverage
| contracts/src/Ostrakon.sol | 100.00% (179/179) | 100.00% (224/224) | 100.00% (47/47) | 100.00% (26/26) |
                               lines               statements          branches          functions
```

Gas, from `npm run gas:report` and `forge test -vvvv` (optimizer, 10,000 runs). The snapshot is in `.gas-snapshot`.

| Call | Gas |
|---|---|
| `vote` (first vote, cold) | 82,676 |
| `registerVoters` × 200 (the cap) | 9,472,010 (≈ 47,360 per address; 32% of a 30M block) |
| `registerVoter` (median) | 80,551 |
| `createElection` (median / 32 candidates) | 244,631 / 1,086,953 |
| `advancePhase` (median) | 34,428 |
| `finalize` (median) | 43,285 |

The reference contract for comparison: `createElection` cost 153,431 with 2 candidates and 366,194 with 10, and a 1,200-address bulk registration ran out of gas at 30M (AUDIT C-05, C-11).

**Slither 0.11.6** on the final contract, run in the clean clone:
```
Detector: timestamp              createElection   (Ostrakon.sol#162)
Detector: timestamp              _effectivePhase  (Ostrakon.sol#400, #404)
Detector: cyclomatic-complexity  createElection (13)
INFO:Slither:. analyzed (1 contracts with 102 detectors), 3 result(s) found
```
All three are triaged in [SECURITY.md](SECURITY.md). Slither isn't an npm dependency because it's Python. I installed it with `pip install slither-analyzer` in a throwaway venv and ran it with Foundry on `PATH`.

## 3. Scripted full lifecycle (`npm run lifecycle`)
This starts its own anvil on :8547, deploys, and asserts through **`web/src/chain/reads.ts` and `errors.ts`**, the same read paths and error decoder the UI uses.
```
▸ create
  ✓ listElections returns the new election
  ✓ phase starts at Registration
  ✓ creator is admin
▸ register batch (with a repeat and the zero address)
  ✓ voterCount == 4 (repeat and zero skipped)
  ✓ getAllVoters lists them in order
▸ advance to Voting
  ✓ phase is Voting
▸ votes
  ✓ double vote rejected before reaching a wallet: "This account has already voted in this election."
  ✓ unregistered vote rejected: "This account is not registered for this election."
  ✓ invalid candidate rejected: "That candidate does not exist."
  ✓ tallies are [1, 2, 0] after the rejected attempts
  ✓ totalVotes == 3
  ✓ voter #2 status: registered and voted
  ✓ voter #5 status: registered, not voted
  ✓ account #7 not registered (ledger batch view)
▸ end + finalize (finalize sent by a non-admin)
  ✓ phase Ended and finalized
  ✓ winner is Grace (index 1), no tie
  ✓ leaders() agrees with the contract
▸ audit trail
  ✓ 1 ElectionCreated
  ✓ 4 VoterRegistered
  ✓ 2 PhaseChanged
  ✓ 3 Voted (rejected attempts left no trace)
  ✓ 1 Finalized
  ✓ findMyVotes finds exactly voter #3's vote via the indexed topic
  ✓ log is in block order

lifecycle: 24 assertions passed
```

## 4. Browser run of the real app (`npm run test:e2e`)
`scripts/e2e.ts` runs these steps:
1. Starts anvil on :8546.
2. Deploys and seeds.
3. Builds with `VITE_E2E=1` into `dist-e2e/`.
4. Serves it with `vite preview`.
5. Runs Playwright in the installed Chrome.

The test-only wallet is wagmi's `mock` connector. It answers account and chain requests and forwards everything else, including `eth_sendTransaction`, to anvil, so the transactions are real. Locked and wrong-chain states use a stub EIP-1193 `window.ethereum` going through the app's **real `injected` connector**.

```
ok  1 read-only without a wallet: ledger, network bar, explanation
ok  2 locked wallet is detected and explained
ok  3 wrong chain: switched on connect, detected when the wallet changes network, one-click fix
ok  4 a rejected connection shows curated copy only
ok  5 registered voter votes with the keyboard; tally and eligibility update
ok  6 unregistered account sees why it can't vote
ok  7 admin: validate a pasted list, register, run the election to a result
ok  8 non-admin cannot see admin controls
ok  9 audit: verify-my-vote shows only what the chain proves
ok 10 anyone can create an election and lands on it
ok 11 360px: no horizontal scroll, ledger rows stack
ok 12 reduced motion: final values render immediately, no transitions
ok 13 stale deployment (no code at the saved address) is explained, not blank
ok 14 unreachable chain is explained, not blank
ok 15 missing deployment.json explains how to get one
15 passed · 2 skipped (the screenshot generator, which only runs with SHOTS=1)
```
- Every test that can surface errors also checks that the page text contains no raw-error patterns: `execution reverted`, `ContractFunction`, `Error:`, stack frames, long hex blobs, viem's `Details:` or `Version:` lines.
- Test 5 is keyboard only: focus, then Enter, then Space, then Enter.
- Test 11 checks `scrollWidth ≤ innerWidth` at 360px on `/`, `/e/1`, `/audit`, `/how`, and `/new`.

**The test connector is excluded from production builds.** In the clean clone:
```
$ grep -rlE 'Mock Connector|__OSTRAKON_E2E__|testConnector' dist/ | wc -l
0
$ grep -rlE 'Mock Connector|__OSTRAKON_E2E__' dist-e2e/
dist-e2e/assets/testConnector-BcXJ3sdj.js        (positive control: present in the E2E build)
```
It's only reachable through `if (import.meta.env.VITE_E2E === "1") await import("./testConnector")`. In a normal build, Vite replaces that condition with a constant false, so the chunk is never emitted.

### Manual checks (in-app browser against `npm run dev`)
- **Phase 1 one-command run.** `npm run dev` printed `0x5fbdb2315678afecb367f032d93f642f64180aa3 (block 1)`, "wrote web/public/deployment.json", the account and role table, and the Vite URL. In a browser with no wallet, the page showed `rpc=up code=present`, the live block, and all 5 seeded elections, with 0 console errors and 0 failed requests (58 resources).
- **Timestamp phase, live.** Election 5 ("opens in 10 minutes") showed *Registration* at first and *Voting* after its scheduled time passed, with no transaction sent.
- **Real MetaMask: not tested.** The browsers I could drive have no extension wallet. MetaMask-specific behavior is therefore covered only by the stub provider in tests 2–3: the `_metamask.isUnlocked` lock hint, and switch-or-add chain through `wallet_switchEthereumChain`. See "Not executed" below.

## 5. Restarting the local chain under an open app
`/e/1` was open in the in-app browser against `npm run dev`.

1. **Killed only anvil** (`Stop-Process` on the PID listening on :8545; Vite kept running).
   - First attempt: the page took about 5–14 s to show "Can't reach the chain", because viem's default retries ran across the WS→HTTP fallback.
   - **Second bug found:** after I started a *fresh* anvil, the page **never recovered**. viem's `watchBlockNumber` only emits block numbers *greater* than the previous one (`if (blockNumber > prevBlockNumber) emit…` in `actions/public/watchBlockNumber.ts`), so a chain restarting at block 0 was invisible.
   - **Fix (`163133a`):** a dedicated 1 s poll on a no-retry HTTP client (2.5 s timeout) that handles outage, recovery, and backwards block numbers, and re-checks contract code every 10 s.
2. Fresh anvil with no contract → reload → "**The contract isn't at the saved address**", with the address, the likely cause, and `npm run chain:deploy`.
3. `npm run chain:deploy` with the page still open → the notice cleared and the election re-rendered at block #27. **No reload.**
4. Killed anvil again with the page open. The page measured the time until the notice appeared:
   ```
   { detectedAfterMs: 1528, mainStillHasContent: true, notices: ["CAN'T REACH THE CHAIN", "READ-ONLY MODE"] }
   ```
5. Started a fresh anvil. Same page, no reload:
   ```
   { staleDetectedAfterMs: 965, block: "#0", notices: ["THE CONTRACT ISN'T AT THE SAVED ADDRESS …", …] }
   ```
At no point was the screen blank. Last-known content stays visible, and the notices say so. E2E tests 13–15 now cover the stale, unreachable, and missing-deployment states automatically.

## 6. Performance, reduced motion, scroll smoothness
Production build (`npm run build`), served by `vite preview`, audited with Lighthouse through Chrome DevTools (desktop).

| | First run | After fixes |
|---|---|---|
| Accessibility | 100 | **100** |
| Best Practices | 100 | **100** |
| SEO | 91 (no robots.txt) | **100** |
| Cumulative Layout Shift | **0.42** ✗ | **0.076** (Lighthouse) / **0.06** (trace) |
| LCP (trace, no throttling) | 103 ms | **81 ms** |

The CLS fixes:
- Wallet presence is detected synchronously, so the "Read-only" notice is there on first paint.
- The ledger reserves its space while loading.
- Core font faces load in parallel with `deployment.json` (capped at 800 ms), so the first paint doesn't re-wrap. The trace's CLS culprits had named the Public Sans and Plex Mono swaps.

Lighthouse's "llms.txt" audit still fails. It isn't applicable to a local DApp. The Performance *category* score isn't reported because the DevTools Lighthouse tool excludes it; the trace metrics above stand in for it.

**Bundle:**
- The first production build had a 253 kB gzipped main chunk.
- Replacing the `motion` library with about 200 lines of local hooks brought it to 202 kB.
- Lazy-loading every route except the ledger left the entry at 72 kB plus shared vendor chunks (66 + 16 + 30 + 12 kB gzipped). Each other screen is 1.4–3.9 kB.

**Reduced motion:** E2E test 12 emulates `prefers-reduced-motion: reduce`. The visible tally digits equal the real values immediately, and `transition-duration` computes to `0s`.

**Scroll smoothness:** `/e/1` (scroll-linked rail and chain line), Chrome DevTools at **4× CPU throttling**, 1280×720. A script scrolled the full page down and back in 240 steps, one per animation frame, recording every frame interval:
```
{ scrollableHeight: 1047, frames: 239, meanMs: 4.17, p50: 4.2, p95: 4.3, p99: 4.3, maxMs: 4.3, over20ms: 0, over33ms: 0 }
```
No frame exceeded 16.7 ms. **Caveat:** the ~4 ms cadence shows that this DevTools-controlled Chrome wasn't vsync-limited to 60 Hz. So this proves the per-frame work fits easily in a 60 fps budget, not what a particular laptop's compositor does. The scroll handler only reads one `getBoundingClientRect` and writes two transforms per frame.

## Not executed, and why
- **Real MetaMask extension.** None of the browsers available to me in this session have an extension wallet installed, and I didn't install one. The injected-connector path is exercised with a stub provider. One manual check remains for a person: import a test key into MetaMask, connect, vote, and switch networks in MetaMask.
- **Touch devices.** There's no physical touch test. Tilt is mouse-only by design (`pointerType === "mouse"`), every card is a `<button>`, and the 360px layout is tested, but a real tap-through on a phone wasn't done.
- **Firefox and Safari.** E2E runs in Chrome only.
- **Testnet deployment.** I didn't deploy to a public network: the brief says to ask first.
