# Verification

Every result below came from running the command shown. Outputs are trimmed to the relevant lines and otherwise unedited. Where a result comes from an earlier commit, it says so and why it still applies.

**Environment:** Windows 11, Node v22.23.1, npm 10.9.8, Foundry 1.8.5 (forge/anvil; SHA-256 of the release zip checked against the published `.sha256`), solc 0.8.30. Browsers: Playwright 1.64.1 driving installed Chrome, plus Playwright WebKit 27.2 for desktop and iPhone 14. Slither 0.11.6, Lighthouse 12.6.0 (CLI).

## Latest run (`459b83a`, 2026-10-16)
This is the full suite run again in the working checkout at `459b83a`, not in a fresh clone:
```
npm run lint           exit=0
npm run typecheck      exit=0
npm test               exit=0   (111 Foundry + 21 Vitest)
npm run coverage       exit=0   (100% lines 280/280, statements 338/338, branches 78/78, functions 42/42)
npm run build          exit=0   (test connector in dist/: 0 files)
npm run lifecycle      exit=0   (49 assertions)
npm run test:deploy    exit=0   (17 checks)
npm audit              found 0 vulnerabilities
npm run test:e2e       chrome 23 passed · webkit 23 passed · mobile-chrome 24 passed · mobile-safari 24 passed
                       firefox 23 passed (PLAYWRIGHT_BROWSERS_PATH, see §4)
```
Lighthouse 12.6.0 was measured at `74ccb4a`. The web app and E2E code haven't changed since:
```
mobile   86 · 100 · 100 · 100 (FCP 2.5 s, LCP 3.7 s, CLS 0, TBT 0 ms)
desktop  99 · 100 · 100 · 100 (FCP 0.6 s, LCP 0.8 s, CLS 0, TBT 0 ms)
```
On mobile, 88% of LCP is render delay. The Ledger heading waits for the JS, the core fonts (capped at 800 ms, to keep CLS at 0), and `deployment.json` on a throttled connection. Painting before the fonts arrive would trade layout stability for a lower LCP, so it's left as is.
The clean-clone results below are from `b063b6f`.

## 1. Clean clone: install, lint, typecheck, tests, build

Fresh `git clone https://github.com/obstinix/ostrakon` into an empty folder, at the final code commit **`b063b6f`**. Before installing, the clone had no `web/src/generated/`, no `deployment.json`, and no allowlist files: everything is generated.

```
npm ci                 exit=0   (239 packages)
npm run lint           exit=0   (forge fmt --check · forge lint -D warnings · eslint --max-warnings 0)
npm run typecheck      exit=0   (forge build → gen-abi → tsc web + tsc node/scripts/e2e)
npm run test           exit=0   (111 Foundry + 21 Vitest)
npm run coverage       exit=0
npm run build          exit=0
npm run lifecycle      exit=0   (49 assertions)
npm run test:e2e -- --projects=chrome,webkit,mobile-chrome,mobile-safari   exit=0
npm run test:e2e -- --projects=firefox                                     exit=1   (environment, see §4)
npm audit --omit=dev   found 0 vulnerabilities
```

Earlier clean-clone runs found three real problems, all fixed before this one:
- **TS2717** at `748ccff`: two E2E specs declared the test-hook type differently.
- **A moderate `uuid` advisory**: `@openzeppelin/merkle-tree` → `@metamask/abi-utils` → `@metamask/utils` → `uuid` 9.0.1. npm's suggested fix downgrades the Merkle library, so instead an `overrides` pin to 11.1.1 was added (`89a7950`). It was re-tested with the allowlist unit, lifecycle, and E2E tests.
- **The mobile layout shift** described in §6.

### Contract tests: unit, fuzz, invariant (`npm run test:contracts`)
```
Suite result: ok. 8 passed   (AccessControlTest)
Suite result: ok. 4 passed   (ViewsTest)
Suite result: ok. 10 passed  (CreateValidationTest)
Suite result: ok. 14 passed  (PhaseTest)
Suite result: ok. 8 passed   (BatchTest)
Suite result: ok. 12 passed  (CoreScenariosTest: the 12 core voting scenarios)
Suite result: ok. 4 passed   (VoteFuzzTest)
Suite result: ok. 6 passed   (FinalizeTest)
Suite result: ok. 22 passed  (SecretBallotTest: commit–reveal)
Suite result: ok. 14 passed  (AllowlistTest: Merkle allowlist, incl. a 2..2,000-member electorate fuzz)
Suite result: ok. 8 passed   (TwoStepAdminTest)
[PASS] invariant_allowlistOnlyListed
[PASS] invariant_finalizeOnlyWhenEnded
[PASS] invariant_noDoubleVote
[PASS] invariant_phaseMonotonic
[PASS] invariant_secretBallot
[PASS] invariant_talliesSumToTotal
Ran 12 test suites: 111 tests passed, 0 failed, 0 skipped (111 total tests)
```
- Fuzz tests run 1,024 times each (fixed seed in `foundry.toml`).
- Invariants run 256 runs × depth 64 over four elections: open/manual, open/scheduled, secret, and open with only a Merkle allowlist.
- Handler call counts per campaign: each of `register`, `advance`, `vote`, `commit`, `reveal` (sometimes with a tampered salt), `claim` (members and outsiders with members' proofs), `warp`, and `finalize` was called about 2,000–2,100 times.

**Do the tests actually bite?** I checked by mutation (`contracts/src/Ostrakon.sol` edited, tests run, file restored):

| Mutant | Caught by |
|---|---|
| Delete the `AlreadyVoted` check | `invariant_noDoubleVote` ("voted at most once: 2 > 1"), `invariant_talliesSumToTotal` |
| A vote for candidate 0 also adds one to candidate 1 | `invariant_talliesSumToTotal` ("sum(tallies) == totalVotes: 2 != 1") |
| `advancePhase` sets Voting → Registration | `invariant_phaseMonotonic` ("phase went backwards") |
| Ended is reported as Voting for manual elections | 10 unit tests (a liveness bug, not a monotonicity violation, so the invariant can't see it) |
| `revealVote` skips the commitment check | `invariant_secretBallot` ("reveal with wrong salt accepted") |
| The `AlreadyRevealed` check is deleted | `invariant_secretBallot` ("revealed only what was committed: 2 > 1") |
| Merkle proof not verified (`_registerByProof` accepts anything) | `testFuzz_largeElectorate`, `test_badProofsRejected`, `test_voteWithProofRules`, `invariant_allowlistOnlyListed` ("outsider claim accepted") |
| Admin transfer completes in one step | 5 tests in `TwoStepAdminTest` plus `test_transferAdmin` ("nomination alone changes nothing") |

All 111 pass again after each restore.

### Frontend unit tests (`npm run test:web`)
```
 Test Files  6 passed (6)
      Tests  21 passed (21)
```
- `errors.test.ts`:
  - every custom error in the ABI has curated copy
  - reverts are mapped by name, with arguments
  - raw text never comes back out
  - wallet rejection, network failure, and receipt-timeout are classified
- `voters.test.ts`: list preview (valid, duplicate, already-registered, zero, malformed, bad checksum) and chunking.
- `secret.test.ts`: `commitmentHash` binds every input; receipt parsing; reveal-schedule rules in the create form.
- `allowlist.test.ts`:
  - trees round-trip through the published JSON
  - members prove, outsiders don't
  - a member's proof doesn't work for anyone else
  - tampered and foreign files are rejected
- `wallets.test.ts`: EIP-6963 wallets win over the generic `window.ethereum` connector.
- `tx.test.ts`: only a "repriced" wallet replacement counts as the user's action.

## 2. Coverage, gas, static analysis

```
$ npm run coverage
| contracts/src/Ostrakon.sol | 100.00% (280/280) | 100.00% (338/338) | 100.00% (78/78) | 100.00% (42/42) |
                               lines               statements          branches          functions
```

Gas, from `npm run gas:report` and `forge test -vvvv` (optimizer, 10,000 runs). The snapshot is in `.gas-snapshot`.

| Call | Gas |
|---|---|
| `vote` (first vote, cold) | 82,676 |
| `commitVote` / `revealVote` | 83,085 / 85,571 |
| `voteWithProof` (claim + vote) | 157,811 |
| `setAllowlist` (root + short link) | 77,707 |
| `transferAdmin` (nominate) / `acceptAdmin` | 50,489 / 35,982 |
| `registerVoters` × 200 (the cap) | 9,472,010 (≈ 47,360 per address; 32% of a 30M block) |
| `createElection` (median / 32 candidates) | 244,631 / 1,086,953 |
| `finalize` (median) | 43,285 |

For a large electorate, the allowlist replaces N × 47k gas paid by the admin with one ~78k `setAllowlist`. Each voter then pays their own claim, folded into their vote.

**Slither 0.11.6**, run in the clean clone:
```
Detector: timestamp              _create          (Ostrakon.sol#610)
Detector: timestamp              _effectivePhase  (Ostrakon.sol#653, #657, #661)
Detector: cyclomatic-complexity  _create (13)
INFO:Slither:. analyzed (3 contracts with 102 detectors), 3 result(s) found
```
All three are triaged in [SECURITY.md](SECURITY.md). The three contracts are `Ostrakon`, OZ `MerkleProof`, and OZ `Hashes`.

**`forge lint -D warnings`** is clean. The `reentrancy-events` warnings that appeared with `MerkleProof` are false positives. A scan of the deployed bytecode for call-family opcodes found none:
```
call-family opcodes in deployed bytecode: none
```

## 3. Scripted full lifecycle (`npm run lifecycle`)
This starts its own anvil on :8547 and asserts through **`web/src/chain/reads.ts`, `errors.ts` and `lib/allowlist.ts`**, the same code the UI uses.
```
▸ create · register batch · advance · votes
  ✓ … 14 assertions (open ballot: create, batch with repeat and zero, phases)
  ✓ double vote rejected before reaching a wallet: "This account has already voted in this election."
  ✓ unregistered vote rejected: "This account is not registered for this election."
  ✓ invalid candidate rejected: "That candidate does not exist."
▸ end + finalize · audit trail                                   ✓ … 10 assertions
▸ secret ballot                                                  ✓ … 15 assertions
  ✓ reveal with a different choice rejected: "That receipt doesn't match the sealed vote on chain. …"
  ✓ tallies [1, 0, 2]: only revealed votes count
▸ allowlist: 500-address list built with @openzeppelin/merkle-tree (the app's builder)
  ✓ root and link read back through getAllowlist
  ✓ #2 registered itself during Registration with a JS-built proof
  ✓ allowlist frozen once voting opens: "That needs the Registration phase, but the election is in Voting."
  ✓ #3 registered and voted in one transaction
  ✓ outsider using a member's proof rejected: "This account isn't on the election's allowlist, or the list you loaded doesn't match it."
  ✓ voterCount counts only claimed members (2 of 500)
▸ allowlist + secret ballot: seal with a proof, then reveal
  ✓ #4 registered and sealed in one transaction
  ✓ revealed vote counted for Ada
▸ two-step admin hand-over
  ✓ nomination leaves the admin unchanged
  ✓ only the nominee can accept: "This account hasn't been nominated as this election's admin."
  ✓ nominee accepted and is now admin

lifecycle: 49 assertions passed
```
Two cross-checks come from this run:
- Proofs built by the browser's Merkle code are accepted on chain.
- Commitments computed by the browser's `commitmentHash` reveal successfully.

### Remote deploy script (`npm run test:deploy`)
This starts an anvil on :8548 with chain id 4242, so `scripts/deploy-remote.ts` treats it as a non-local network and every guard is active. Nothing leaves the machine.
```
ok    no RPC: refused
ok    malformed key: refused
ok    out-of-range key: refused without echoing it or a stack trace
ok    RPC failure mid-run: reported without the deploy RPC's API key or a stack trace
ok    Anvil test key on a non-local chain: refused
ok    no public RPC on a non-local chain: refused
ok    unfunded deployer: refused
ok    dry run: estimates, sends nothing, writes nothing
ok    --yes: deploys and writes the record
ok    record matches the app's deployment schema
ok    record names the chain
ok    record carries the public RPC, not the deploy RPC
ok    the deploy RPC's API key appears nowhere
ok    the private key appears nowhere
ok    contract code exists at the recorded address
ok    deployTx created that address
ok    deployBlock matches the receipt

17 checks passed
```
The two leak checks were added after a review found that the first version of the script let library errors through. An out-of-range key crashed inside `@noble/curves` and printed the key as a decimal number. A failing RPC printed viem's error, which names the request URL, so an API key in that URL was printed 5 times in one run. Both checks fail against that version.
No deployment to a public network was made: that needs the owner's go-ahead, a funded key, and an RPC provider.

## 4. Browser runs of the real app (`npm run test:e2e[:all]`)
`scripts/e2e.ts` builds once with `VITE_E2E=1` into `dist-e2e/` and serves it on :4174. Then, **for each Playwright project**, it:
1. starts a fresh anvil on :8546
2. deploys and seeds
3. runs that project's tests

The test-only wallet is wagmi's `mock` connector, which forwards transactions to anvil, so they are real. Wallet edge cases use stub EIP-1193 or EIP-6963 providers that go through the app's **real injected connector**.

| Project | Engine / device | Result |
|---|---|---|
| chrome | installed Chrome, desktop | **23 passed**, 5 skipped |
| firefox | Playwright Firefox 157, desktop | **23 passed**, 5 skipped (browser copied outside `ms-playwright`, see below) |
| webkit | WebKit 27.2 (Safari engine), desktop | **23 passed**, 5 skipped |
| mobile-chrome | Pixel 7 emulation, touch | **24 passed**, 4 skipped |
| mobile-safari | iPhone 14 emulation (WebKit), touch | **24 passed**, 4 skipped |

Skipped tests:
- The screenshot and perf specs, which are opt-in.
- The touch-only test on desktop.

The 23 shared tests, plus the touch test:
```
read-only without a wallet · locked wallet · wrong chain switch · rejected connection ·
keyboard-only vote · unregistered account · admin: list preview, register, publish allowlist, run to result ·
non-admin can't see admin controls · audit verify-my-vote · secret ballot (seal; wipe receipt and
"Recover with my wallet"; declined signature falls back to random secret; reveal with stored receipt;
reveal on a fresh device by pasting the receipt, wrong receipt refused) · create open + secret election ·
360px no horizontal scroll on 7 routes · 360px network bar values not clipped · reduced motion · stale deployment · unreachable chain ·
missing deployment.json · allowlist voter loads list from the admin's link and votes with a proof ·
allowlist outsider + tampered list · two-step admin hand-over · MetaMask 4902 add-chain-then-switch ·
MetaMask lock (accounts emptied) drops to read-only · EIP-6963 chooser picks the right wallet ·
[touch] tap a card open and vote, no hover
```
Every test that can surface errors also scans the page text for raw-error patterns: `execution reverted`, `ContractFunction`, `Error:`, stack frames, long hex blobs, and viem `Details:`/`Version:` lines.

**Firefox runs once the browser lives outside `ms-playwright`.** Started from Playwright's default folder, the Firefox build fails at launch on this machine:
```
Error: browserType.launch: spawn UNKNOWN
Windows event log (SideBySide): Activation context generation failed for "...\ms-playwright\firefox-1555\firefox\firefox.exe".
Dependent Assembly mozglue,language="*",type="win32",version="1.0.0.0" could not be found.
```
What was ruled out, and what fixed it:
- **Not a missing runtime.** An earlier version of this file blamed a missing Visual C++ runtime. That was wrong: `vcruntime140.dll` and `msvcp140.dll` ship in the Firefox folder, and `mozglue.dll` is present and embeds the matching assembly manifest.
- **The binaries are fine.** The same folder copied elsewhere starts (`Mozilla Firefox 157.0`), while a copy placed inside `ms-playwright` fails again. The one difference found is an extra inherited AppContainer capability entry (`S-1-15-3-…`) in the `ms-playwright` folder's permissions. That's a property of this machine, not of the project.
- **The fix.** Copy the browser elsewhere and point Playwright at the copy. No repository or system change is needed:
  ```
  cp -r ~/AppData/Local/ms-playwright/firefox-1555 <dir>/
  PLAYWRIGHT_BROWSERS_PATH=<dir> npm run test:e2e -- --projects=firefox
  ```
  Result: **23 passed**, 5 skipped (the same opt-in and touch-only skips as desktop WebKit).

**The test connector is excluded from production builds.** In the clean clone:
```
$ grep -rlE 'Mock Connector|__OSTRAKON_E2E__|testConnector' dist/ | wc -l
0
$ grep -rlE 'Mock Connector|__OSTRAKON_E2E__' dist-e2e/
testConnector-*.js      (positive control: present in the E2E build)
```

### Manual checks
- **One-command run.** `npm run dev` deploys to `0x5fbdb2315678afecb367f032d93f642f64180aa3 (block 1)`, seeds seven elections, writes `web/public/deployment.json` and `web/public/allowlists/7.json`, prints the account and role table, and serves the app.
- **Chain restart under an open app** (§5) was measured at `163133a`. The health-check code it exercised hasn't changed since. E2E tests for stale, unreachable, and missing-deployment states run on every commit.

### Manual MetaMask checklist (not executed)
Onboarding a real MetaMask means creating a wallet and setting a password inside a third-party extension. That's outside what I'll do on someone's behalf, so these steps are left for a person. Its protocol behavior is covered by the stub-provider tests above.
1. `npm run dev`, then `npm run keys`. In MetaMask, import key #4.
2. Open http://localhost:5173 → **Connect wallet**. MetaMask should offer to add or switch to *Anvil (local)* (chain 31337).
3. Election 1: vote (two prompts are expected only for secret ballots).
4. Election 6: seal a vote. MetaMask shows a signature request with the recovery message, then a transaction.
5. In MetaMask, switch to another network. The app shows "Wallet is on a different network" → **Switch network**.
6. Lock MetaMask. The app drops to read-only.
7. Election 7: load the list from the admin's link, then vote. One transaction registers and votes.

## 5. Restarting the local chain under an open app (measured at `163133a`)
1. **Killed only anvil.** This found two bugs, both fixed in `163133a`:
   - Detection originally took 5–14 s because of viem retries.
   - After a *fresh* anvil started, the page never recovered. viem's `watchBlockNumber` only emits block numbers greater than the last, so a chain restarting at 0 was invisible.
   - **Fix:** a 1 s no-retry health poll that handles outage, recovery, and backwards block numbers, and re-checks contract code every 10 s.
2. Fresh anvil, no contract → "**The contract isn't at the saved address**" with `npm run chain:deploy`. Running that cleared the notice with **no reload**.
3. Killed with the page open: `{ detectedAfterMs: 1528, mainStillHasContent: true }`. Fresh anvil: `{ staleDetectedAfterMs: 965, block: "#0" }`.

## 6. Performance, layout stability, reduced motion, scroll
Production build (`npm run build` at `b063b6f`), `vite preview`, **Lighthouse CLI 12.6.0** with installed Chrome. Mobile uses Lighthouse's default simulated slow 4G and 4× CPU.

| | Desktop | Mobile |
|---|---|---|
| Performance | **99** | **86–89** (two runs) |
| Accessibility | 100 | 100 |
| Best Practices | 100 | 100 |
| SEO | 100 | 100 |
| First Contentful Paint | 0.6 s | 2.5 s |
| Largest Contentful Paint | 0.8 s | 3.4–3.7 s |
| Total Blocking Time | 0 ms | 0 ms |
| **Cumulative Layout Shift** | **0** | **0** |

**History.**
- *Desktop CLS:* 0.42 → 0.076 (first round).
- *Mobile CLS:* 0.15, found in this round by reading `LayoutShift` events in a saved Lighthouse trace. `main` moved from y=170 to y=332 because wagmi's "reconnecting" state delayed the no-wallet notice. That and two smaller causes are fixed (DESIGN.md "Layout stability"). Mobile CLS is now **0**.
- *Mobile FCP:* 3.1 s → 2.5 s after the first screen's font files were preloaded from the HTML head.
- *Mobile LCP:* bounded by the chain reads the ledger needs before it can show anything.
- *Lighthouse's "llms.txt" audit:* fails, and isn't applicable.

**Bundle (gzipped).**
- Entry: 72.5 kB.
- Shared viem/wagmi chunk: 66.9 kB.
- The Merkle library is a separate **lazy** 35.9 kB chunk, loaded only on allowlisted elections and the admin panel.
- `secp256k1` (12 kB) and `localBatchGatewayRequest` (27 kB) are static imports of viem/wagmi's core. Splitting them out would mean restructuring how wagmi is loaded, so I left them.

**Reduced motion:** the E2E reduced-motion test checks that visible tally digits equal the real values immediately and that `transition-duration` is `0s`.

**Scroll smoothness** (`PERF=1 npm run test:e2e -- e2e/perf.spec.ts`, Chrome, CDP CPU throttling ×4, 1280×720, full page scrolled down and back in 240 per-frame steps):
```
PERF /e/1 {"frames":239,"p50":4.2,"p95":4.3,"maxMs":12.5,"over16_7ms":0}
PERF /e/6 {"frames":239,"p50":4.2,"p95":4.3,"maxMs":4.3,"over16_7ms":0}
```
No frame exceeded 16.7 ms. **Caveat:** headless Chrome isn't vsync-limited, so this shows the per-frame work fits a 60 fps budget, not what a specific laptop's compositor does.

## Not executed, and why
- **Real MetaMask extension:** blocked by policy (it requires creating a wallet and password in a third-party extension). There's a stub coverage plus a manual checklist (§4).
- **CI:** a workflow is prepared in `docs/ci/github-actions.yml`, but it isn't enabled, because GitHub Actions is a hosted service that needs the owner's approval. It has never run. Enabling it means moving it to `.github/workflows/`. Its commands are the ones in this file, but the Linux runner and Playwright's bundled Chromium (`PW_CHANNEL=""`) are untested.
- **Physical phones:** Pixel 7 and iPhone 14 are emulated (viewport, touch, user agent, WebKit for iPhone), not real devices.
- **Testnet deployment:** not done, because the brief says to ask first, and it needs a funded key and an RPC provider. The script for it (`npm run deploy:remote`) exists and is checked locally (§3).
