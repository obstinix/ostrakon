# Audit of the reference project (the reference project)

**Subject:** `reference-app.zip` (Hardhat + CRA + web3.js) and `reference report (PDF)` (25 pages).
**Method:** I unzipped the reference into a scratch folder outside this repo and read every source file and the full report. Then I ran it: install, compile, test, deploy to a local `hardhat node`, run `getOwner.js`, build the frontend (fresh-clone, CI, and normal modes), and load it in a browser with no wallet. I also ran a behavioral probe script (not part of the reference) against the contract on the in-process Hardhat network.
**Environment:** Windows 11, Node v22.23.1, npm 10.9.8, hardhat 2.26.3, hardhat-toolbox 2.0.2 (ethers 5.8.0), react 17.0.2, solc 0.8.9.

Evidence types:
- **RUN** means I executed a command; its output is quoted.
- **STATIC** means I found the issue by reading the code and did not execute it. Each STATIC entry says why it was not run.

The **Ostrakon** column states whether the new design avoids the issue. Its status is **design intent** until `docs/VERIFICATION.md` records the proof. Every issue I found is listed, including the ones I chose not to address.

Severity scale: **Critical**, the system doesn't work or votes can be wrong. **High**, a correctness or security property promised by the report is broken. **Medium**, a robustness or UX failure. **Low**, hygiene.

---

## 1. Build, tooling, and run

### A-01 · Critical · The automated test suite never runs (RUN)
`test/Voting.test.js:1-2` uses ESM `import` in a CommonJS project (no `"type": "module"`, `hardhat.config.js` uses `require`).
```
$ npx hardhat test
SyntaxError: The requested module 'hardhat' does not provide an export named 'ethers'
```
After I converted the two imports to `require` in a scratch copy, it still fails completely:
```
  0 passing (1s)
  5 failing
  1) Voting Contract  Should register a voter:  TypeError: voting.registerVoter is not a function
  ... (all 5 identical)
```
The tests target a different contract (`registerVoter`, `isRegistered`, `vote(uint)`, `hasVoted(address)`, `tallyVotes()`). None of those exist in `contracts/Voting.sol`. Report §6.7 says scenarios "can be verified … with automated Hardhat tests (npx hardhat test)", which is not true of the submitted code. Root `package.json:7` has `"test": "echo \"Error: no test specified\" && exit 1"`.
**Ostrakon:** I'm writing the Foundry test suite from scratch: unit, fuzz, and invariant tests, with every report scenario mapped to a named test, run by `npm test`.

### A-02 · Critical · Later Hardhat commands silently delete the deployment file (RUN)
`hardhat.config.js:16` points Hardhat's `artifacts` path at `frontend/src/artifacts`. `scripts/deploy.js:18-23` then writes `contract-address.json` and `Voting.json` into that same managed directory. Hardhat prunes files it doesn't own on every compile:
```
$ npx hardhat run scripts/deploy.js --network localhost
Voting deployed to: 0x71C95911E9a5D330f4D621842EC243EE1343292e
### after deploy:   Voting.json  Voting.sol  contract-address.json
$ npx hardhat compile
Nothing to compile
### after compile:  Voting.sol
```
This also breaks the project's own helper:
```
$ npx hardhat run scripts/getOwner.js --network localhost
Error: Cannot find module '../frontend/src/artifacts/contracts/contract-address.json'
```
After any `compile`, `test`, or `run`, the frontend has no address. `Web3Context.js:85-95` then swallows the missing file and only logs a console warning.
**Ostrakon:** Deployment output goes to a dedicated generated file outside any tool-managed directory. The dev script writes it after deploy, and the app validates it at runtime by checking code at the address.

### A-03 · High · A fresh clone can't build the frontend (RUN)
`.gitignore:10` ignores `frontend/src/artifacts`, and `Web3Context.js:3` statically imports from it.
```
$ npm run build      # frontend, before any compile
Module not found: Error: Can't resolve '../artifacts/contracts/Voting.sol/Voting.json' in '...\frontend\src\contexts'
```
**Ostrakon:** The typed ABI is generated as part of `npm run dev` and `npm run build`. I'll test a clean-clone build in Phase 5.

### A-04 · High · The build fails under CI settings (RUN)
`Web3Context.js:35` uses `/\u0000/g` and trips `no-control-regex`. CRA treats warnings as errors when `CI=true`:
```
$ CI=true npm run build
Failed to compile.
src\contexts\Web3Context.js  Line 35:63:  Unexpected control character(s) in regular expression: \x00  no-control-regex
```
**Ostrakon:** Lint is a separate gate (`npm run lint`) that must pass with zero warnings.

### A-05 · Medium · Running the app takes three terminals and manual steps (RUN, per README)
README §2–5: you start the node, deploy, and start the frontend in separate terminals. Then you configure MetaMask by hand and import private keys. Nothing seeds data. Every node restart needs a manual redeploy.
**Ostrakon:** One command (`npm run dev`) starts the chain, deploys, seeds data, generates the ABI and address, and starts the app.

### A-06 · Medium · The docs disagree on which account is admin (RUN)
`scripts/deploy.js:8` deploys from `signers[1]`:
```
Deploying from: 0x70997970C51812dc3A010C7d01b50e0d17dc79C8   (Hardhat account #1)
```
README line 90 says "**Account #0** will be the contract owner (Admin)." Report §6.5/§6.6 says Account #1. A user following the README gets "Access Denied".
**Ostrakon:** There is no global owner (see C-01). The seed script prints exactly which account holds which role.

### A-07 · Medium · `public/index.html` loads files that don't exist (RUN)
`public/index.html:7,11-14` references `styles.css` and `bundle.js` and fetches `/contract-address.json`. The CRA dev server answers all three with `index.html` (`200 text/html`). The browser console shows:
```
[error] Uncaught SyntaxError: Unexpected token '<'
[error] Uncaught (in promise) SyntaxError: Unexpected token '<', "<!DOCTYPE "... is not valid JSON
```
`window.__CONTRACT_ADDRESS` is set by that script and never read.
**Ostrakon:** I'll write a fresh `index.html` with no dead references. Phase 5 checks the console stays clean.

### A-08 · Medium · Vulnerable and unused dependencies (RUN)
`frontend/package.json` declares `@mui/material`, `@mui/icons-material`, `@emotion/*`, `axios@^0.21.1`, `@openzeppelin/contracts`, and `dotenv`. `grep` finds **no** import of any of them in `src/`. The dependency audit reports:
```
$ npm audit --omit=dev
63 vulnerabilities (14 low, 33 moderate, 12 high, 4 critical)
axios <=0.32.0  Severity: high (GHSA-jr5f-v2jv-69x6, ...)
```
The production bundle is 442.83 kB gzipped (`build/static/js/main.*.js`), mostly web3.js 1.x.
**Ostrakon:** I'll keep a minimal dependency set (viem in place of web3.js), record `npm audit` in Phase 5, and record bundle size.

### A-09 · Low · Dead hook with an import that doesn't resolve (STATIC)
`frontend/src/hooks/useWeb3.js:3` imports `../contracts/Voting.json`, which doesn't exist, and reads Truffle-style `networks[networkId]`. Nothing imports this hook, so the build doesn't fail on it. It is dead code that contradicts `Web3Context`.
*Why STATIC:* the file is not reachable from the bundle, so there is nothing to run.
**Ostrakon:** I won't create this file. A single chain-layer module replaces it.

### A-10 · Low · Solidity 0.8.9 is old (RUN: `Downloading compiler 0.8.9`)
0.8.9 predates custom errors in `require`, the `via-ir` maturity work, and several bug fixes.
**Ostrakon:** I'll use `pragma ^0.8.24` with a pinned compiler version in the Foundry config.

---

## 2. Smart contract (`contracts/Voting.sol`)

The probe output below comes from my own script `probe.js`, run with `npx hardhat run` on the in-process network.

### C-01 · High · No election phases: you can register and vote at any time, and nothing closes an election (RUN)
`vote` (L76-86) and `registerVoterForElection` (L52-59) check no state other than `exists`.
```
OK      register a
OK      a votes immediately after registration
OK      register b AFTER votes cast
OK      b votes
```
This lets the admin add voters in the middle of an election after seeing partial results. The report admits it (§8: "no election phases or closing time").
**Ostrakon:** Phases run `Registration → Voting → Ended`, move forward only, and can also be enforced by timestamp.

### C-02 · High · No winner or finalization (RUN)
```
public functions: createElection, electionCount, getCandidates, getElectionCount, getElectionName,
getVoters, getVotes, owner, registerVoterForElection, registerVotersForElection, vote
```
There is no close, finalize, winner, or tie function. The UI shows only live percentages.
**Ostrakon:** `finalize(electionId)` is callable by anyone after `Ended`. It computes the winner or a tie and emits `Finalized`.

### C-03 · High · No input validation on `createElection` (RUN)
L36-49 only checks `length > 0`:
```
OK      empty election name ''
OK      single candidate
OK      duplicate candidates           (["Same","Same"])
OK      empty candidate name           (["",""])
OK      300-byte name                  (gasUsed=382966)
```
A one-candidate "election" or two identical candidates make the result meaningless.
**Ostrakon:** 2–32 candidates; names non-empty, at most 64 bytes, and unique; election name at most 80 bytes. Each rule has a custom error and a test.

### C-04 · Medium · You can register `address(0)` (RUN)
```
OK      register address(0)
```
It inflates the voter list with an address that can never vote.
**Ostrakon:** Rejected for single registration with `ZeroAddress`. Skipped in batch registration, like duplicates.

### C-05 · High · Unbounded batch registration (RUN)
L62-73 loops over the caller-supplied array with no cap:
```
REVERT  bulk register 1200 addresses in one tx  -> Transaction ran out of gas    (gasLimit 30,000,000)
```
An admin who pastes a large list gets an opaque out-of-gas failure. Report §8 lists "gas optimisation of bulk registration" as future work.
**Ostrakon:** I'll document a cap (`MAX_BATCH`) with a custom error, and the UI will chunk large lists. Phase 2 measures the gas per address. A Merkle-root allowlist for large electorates is a stretch goal.

### C-06 · High · Single global owner that can't be transferred (RUN)
```
has transferOwnership? false
```
`owner` is set once in the constructor (L25-28) and gates every admin function (L30-33). Only the deployer can ever run elections, and a lost key freezes administration permanently.
**Ostrakon:** Each election has its own `admin`, which is whoever created it. `transferAdmin` is supported. `docs/STACK.md` and the README explain why.

### C-07 · Medium · `getVoters` is owner-only, but the same data is public (RUN)
L113 makes `getVoters` owner-only, yet `VoterRegistered` events (L58, L70) reveal the full list to anyone:
```
REVERT  getVoters from non-owner (as call)  -> Only owner can call this function.
voters reconstructed from events by anyone: 0x0000…0000, 0xf39F…2266, 0x7099…79C8, 0x3C44…93BC
```
The access control suggests a privacy the chain doesn't provide. The report notes this (§8).
**Ostrakon:** The voter list is a public paginated view, and the README says plainly that it is public.

### C-08 · High (privacy) · No ballot secrecy: `Voted` links voter to candidate (RUN)
L23, L85: `event Voted(uint indexed electionId, address indexed voter, uint candidateIndex)`.
```
Voted(election=1, voter=0x70997970C51812dc3A010C7d01b50e0d17dc79C8, candidate=0)
Voted(election=1, voter=0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC, candidate=1)
```
Even without the event, the vote transaction's calldata reveals the choice. The report acknowledges this (§1, §4.6, §8).
**Ostrakon:** The base design **does not** provide ballot secrecy either, and the README will say so. Calldata reveals the choice anyway, so removing the event would be cosmetic. Commit–reveal is a stretch goal, with documented tradeoffs: it hides choices until reveal, not after.

### C-09 · Medium · Missing read views force N+1 reads (RUN, function list above)
There is no `isRegistered`, `hasVoted`, voter count, all-tallies view, or summary view. Tallies take one `getVotes` call per candidate (L106). The frontend can't show a voter's eligibility or whether they've voted before they send a transaction.
**Ostrakon:** `getTallies` returns all tallies in one call. Summary, `isRegistered`, `hasVoted`, voter count, and paginated voters are all views.

### C-10 · Low · Missing events for state changes (STATIC + RUN function list)
There are no events for phase changes (no phases exist), finalization, or admin transfer, so an indexer can't fully rebuild the audit trail from logs.
*Why STATIC:* the events are absent, so there is nothing to execute.
**Ostrakon:** Every state change emits one of `ElectionCreated`, `VoterRegistered`, `PhaseChanged`, `Voted`, `Finalized`, or `AdminTransferred`.

### C-11 · Low · Gas waste and redundant checks (RUN + STATIC)
- L44 `e.votesPerCandidate[i] = 0;` writes the default value, a wasted SSTORE per candidate. 2 candidates cost 153,431 gas; 10 cost 366,194 (RUN).
- L53 checks existence twice: once in `_votingIdOrCheck` and once in the outer `require`, which repeats the same condition.
- L119-122 has a helper commented "not strictly necessary".
- `electionCount` (public, L6) and `getElectionCount()` (L89) duplicate each other.
- `e.exists` uses a full storage slot when `id <= electionCount` would do.
**Ostrakon:** Covered by the rewrite. Phase 2 records a gas snapshot.

### C-12 · Low · Revert strings instead of custom errors; no NatSpec (STATIC)
The contract uses `require(…, "string")` throughout. Strings cost more gas, and the frontend has to regex-match free text (see F-04).
*Why STATIC:* style/cost; the gas difference is measured indirectly in C-11.
**Ostrakon:** Custom errors and NatSpec on every external function.

### C-13 · Low · The admin can register themselves and vote (RUN)
```
OK      register owner as voter
OK      owner self-registered votes
```
This isn't a bug, since admins may be eligible voters. But it's undocumented and worth stating as a trust assumption.
**Ostrakon: not addressed by design.** The admin can register any address, including their own. The README will list this as a trust limitation (the admin controls eligibility), together with Sybil registration.

---

## 3. Frontend (`frontend/src`)

### F-01 · Critical · No read-only mode; nothing renders without a wallet (RUN)
`Web3Context.js:71-75` returns early if `window.ethereum` is missing, so no contract instance is created and no reads happen. With no wallet in the browser:
```
/vote  ->  "Connected as: Not Connected … No elections available … Total Votes: 0"
/admin ->  "Please connect your wallet."           (no connect button exists anywhere)
console -> [error] MetaMask not found   (x2 per load)
```
Report §5.3 FR-5 ("Anyone can view the elections … and the live vote counts") does not hold for anyone without MetaMask.
**Ostrakon:** A public RPC client handles reads, so the app works fully read-only. Connecting a wallet is an explicit button.

### F-02 · High · The provider is mounted twice (RUN + STATIC)
`index.js:8` wraps `<App/>` in `<Web3Provider>`, and `App.js:31` wraps everything in a second `<Web3Provider>`. Each provider runs `initWeb3`: two `eth_requestAccounts` prompts and two listener registrations. The console shows `MetaMask not found` **twice** per page load, once per provider.
**Ostrakon:** One provider, at the root.

### F-03 · High · Listener leak and stale closure (STATIC)
- `Web3Context.js:132` cleans up with `removeListener('accountsChanged', () => {})`, which passes a *new* function, so the real handler from L115 is never removed.
- The handler at L115-121 closes over `owner` as it was at mount (`null`), so it always computes `isAdmin = false`. A second effect (L139-145) corrects it afterwards.
- There's no `chainChanged` listener at all: switching networks in MetaMask leaves a contract object bound to the wrong chain.

*Why STATIC:* this needs an injected EIP-1193 wallet that emits events. The browser available for this audit has none, and building a mock wallet for a codebase that's being replaced wasn't worth it. Ostrakon's test connector will cover the equivalent paths.
**Ostrakon:** One chain module with paired subscribe/unsubscribe for `accountsChanged` and `chainChanged`, with no state captured in closures.

### F-04 · High · Raw errors are rendered in the DOM (STATIC)
- `Web3Context.js:6-59` (`getRevertReason`) falls back to `return nestedMsg` (L23) and `return msg` (L57), which are raw provider and RPC messages.
- `AdminPage.js:8-19` defines a *second*, different `getRevertReason` that shadows the context's. Its regex `/revert\s*([^"]*)/` captures arbitrary text.
- Both outputs go straight into the DOM: `AdminPage.js:190`, `VotingPage.js:101,113`.
- An invalid address pasted into the admin form makes web3.js throw a validation error, which `showError` renders verbatim.

*Why STATIC:* same as F-03; no wallet to send transactions from.
**Ostrakon:** One `decodeError` maps custom-error **names** to curated copy and uses a generic fallback. Raw errors go only to `console.error`.

### F-05 · Medium · Unvalidated input in the admin page (STATIC)
`AdminPage.js:4-6` `parseList` splits on commas only. There's no checksum or address validation, no dedupe preview, and no count before sending. Candidate names aren't validated either (so C-03 is reachable from the UI).
**Ostrakon:** The admin screen validates checksums, dedupes, previews already-registered addresses, and checks names before sending.

### F-06 · Medium · Fixed-interval N+1 polling (STATIC)
`VotingPage.js:38-43` makes one `getVotes` call per candidate, sequentially awaited. L61-65 repeats this every 6 s. `fetchElections` (both pages) makes one `getElectionName` call per election, also sequential. The report describes this as a feature (§1: "refreshes them every six seconds").
**Ostrakon:** Event-driven updates (`watchContractEvent` plus a block-poll fallback) and a single-call `getTallies`.

### F-07 · Medium · Effect re-fetch loop (STATIC)
`VotingPage.js:29` / `AdminPage.js:49`: `fetchElections` depends on `selectedElection`, so changing the selection recreates the callback and re-runs the whole election fetch.
**Ostrakon:** Data comes from chain-derived queries keyed by election id. Selection isn't duplicated into local state.

### F-08 · Medium · No transaction lifecycle UI (STATIC)
`VotingPage.js:79-95`:
- It runs `estimateGas` and then `send`, but there are no "awaiting signature" or "pending (hash)" states and no confirmations.
- After success it calls `setTimeout(refresh, 1000)` and hopes the block is mined.
- Message type is inferred from a `✓`/`✗` prefix (L112).
- The AdminPage shows "Creating election..." in the *success* style before anything has happened (L81).

**Ostrakon:** Explicit `awaiting signature → pending → confirmed → failed` states, simulate-before-send, and an `aria-live` region.

### F-09 · Medium · Vote buttons appear to everyone (RUN: `/vote` renders vote controls regardless of state; STATIC for logic)
There's no eligibility or has-voted check before showing "Vote for X". Unregistered visitors and people who already voted find out only from a failed transaction.
**Ostrakon:** The vote action is derived from the chain: phase, registration, and has-voted.

### F-10 · Medium · No wrong-chain, stale-deployment, or locked-wallet handling (STATIC)
Nothing compares `chainId`. If the node restarts, the saved address has no code and every read fails into `console.error` while the UI shows "No elections available" (`VotingPage.js:26-27`). That's indistinguishable from an empty contract.
**Ostrakon:** The app detects and explains no wallet, locked wallet, wrong chain (with one-click switch or add), no code at the address, and read-only mode. Phase 5 tests the stale-deployment case by restarting the chain.

### F-11 · Medium · `eth_requestAccounts` runs on page load (STATIC)
`Web3Context.js:79` asks to connect immediately on every page visit, unprompted, from both providers (F-02).
**Ostrakon:** Connecting only happens on an explicit user action. Reads work before that.

### F-12 · Low · Accessibility and responsiveness gaps (STATIC)
- There are no `aria-live` regions.
- Status relies on color and glyphs.
- The `<select>`s have no `<label>`.
- Inline styles are scattered through AdminPage.
- `.card-container` has `minmax(300px, 1fr)` and the page has no small-screen handling below about 340 px.

**Ostrakon:** WCAG AA, landmarks, labels, focus rings, and a 360 px layout (Phase 4).

### F-13 · Low · Visual system (STATIC, `App.css`)
`App.css:2` uses a purple primary (`#6366F1`), `Inter`/system font stack, a 4-color bar palette that includes blue and violet (L219-222), shadow stacks on cards (L92), and the "two big CTA cards under a centered hero" home page (`HomePage.js`). These are noted only because the Ostrakon brief bans them.
**Ostrakon:** New design system in `docs/DESIGN.md`.

### F-14 · Low · Owner address shown in the nav, labeled "not loaded" (RUN)
The screenshot shows "Owner: not loaded" in the header (`App.js:22-24`), which is debugging output left in the UI.
**Ostrakon:** A persistent network bar shows chain, block, account, role, and contract, by design.

---

## 4. Report-level discrepancies (for updating the mini project report)

| Report claim | Reality | Ref |
|---|---|---|
| §6.7: scenarios verifiable with `npx hardhat test` | Test file doesn't load; 0/5 tests even apply to this contract | A-01 |
| §5.3 FR-5: anyone can view elections and live counts | Not without MetaMask | F-01 |
| §6.4: address taken from `contract-address.json` written by deploy | The file is deleted by the next Hardhat command | A-02 |
| README: Account #0 is admin | Deploy uses Account #1 | A-06 |
| §5.3 FR-2: admin can view registered voters (implied privacy) | Anyone can rebuild the list from events | C-07 |
| §4.5: "avoids … improper access control" | True for the owner gate. But there are no phases, so registering mid-vote is allowed. | C-01 |

The report's own stated limitations are accurate: no ballot secrecy, admin-dependent eligibility, no phases, no winner. Ostrakon fixes phases and the winner. Ballot secrecy and identity binding stay documented limitations, with commit–reveal as a stretch goal.

## 5. Licensing and credit
- `contracts/Voting.sol:1` declares `SPDX-License-Identifier: MIT`. Root `package.json:11` says `"license": "ISC"`. The zip has **no LICENSE file**.
- Ostrakon copies no code from the reference, so no copy-based license obligation applies.
- This repo's own `LICENSE` is the Boost Software License 1.0, and I'm leaving it as is.

## 6. Issues I chose not to address
- **C-08 / ballot secrecy:** not solved in the base design and documented as such. Commit–reveal is a stretch goal only.
- **C-13 / admin controls eligibility (Sybil, self-registration):** inherent to the allowlist model, documented as a trust limitation. Real identity verification is out of scope.
- **Identity binding** (report §8 "trustworthy identity-verification process"): out of scope, listed in future scope.

---

## 7. Resolution status in Ostrakon (verified)

Evidence is in [VERIFICATION.md](VERIFICATION.md) unless noted.

| Issue | Status | Evidence |
|---|---|---|
| A-01 tests never run | Resolved | 67 Foundry tests (including the 12 report scenarios), 8 Vitest, 15 Playwright; all green from a clean clone |
| A-02 deployment file deleted | Resolved | Deployment goes to `web/public/deployment.json`, outside any tool's artifact folder; checked at runtime against code at the address |
| A-03 fresh clone can't build | Resolved | Clean-clone `npm ci` → `npm run build` exit 0 |
| A-04 fails under CI | Resolved | `npm run lint` uses `--max-warnings 0` and `forge lint -D warnings`; exit 0 |
| A-05 three terminals, manual setup | Resolved | `npm run dev` |
| A-06 admin account mismatch | Resolved | Per-election admin; seed prints roles; `npm run keys` |
| A-07 dead references in index.html | Resolved | 0 failed requests, 0 console errors on load |
| A-08 vulnerable/unused deps | Resolved | `npm audit --omit=dev`: 0 vulnerabilities |
| A-09 dead hook | Resolved | Not recreated |
| A-10 old compiler | Resolved | solc 0.8.30 |
| C-01 no phases | Resolved | `PhaseTest` (14 tests), `invariant_phaseMonotonic` |
| C-02 no winner | Resolved | `FinalizeTest`, fuzz `testFuzz_finalizeMatchesArgmax` |
| C-03 no validation | Resolved | `CreateValidationTest` (10), fuzz `testFuzz_nameLengths` |
| C-04 zero address | Resolved | `test_singleRejectsZero`, `test_batchSkipsZeroAndAlreadyRegistered` |
| C-05 unbounded batch | Resolved | `MAX_BATCH = 200`, full batch costs 9.47M gas; UI chunks longer lists |
| C-06 single owner | Resolved | Per-election admin plus `transferAdmin`; `AccessControlTest` |
| C-07 owner-only list that's public anyway | Resolved | Public paginated `getVoters`; README says the list is public |
| C-08 no ballot secrecy | **Not addressed by design** | Documented in README, How it works, SECURITY.md; commit–reveal is future scope |
| C-09 N+1 reads | Resolved | `getTallies`, `getElections`, `getVoterStatuses` |
| C-10 missing events | Resolved | Six events; event args checked with `vm.expectEmit` |
| C-11 gas waste | Resolved | No zero writes or double checks; `.gas-snapshot` |
| C-12 revert strings | Resolved | Custom errors plus NatSpec |
| C-13 admin can self-register | **Not addressed by design** | Documented as a trust limitation |
| F-01 no read-only mode | Resolved | E2E 1 (read-only), manual check |
| F-02 double provider | Resolved | One `RuntimeProvider` and `WalletProvider` |
| F-03 listener leak, no chain listener | Resolved | wagmi handles connector subscriptions; E2E 3 switches chain mid-session |
| F-04 raw errors in DOM | Resolved | `decodeError` plus Vitest; E2E raw-error scan on every error-capable page |
| F-05 unvalidated admin input | Resolved | `previewVoters` (checksum, dedupe, zero, already-registered); E2E 7 |
| F-06 fixed-interval N+1 polling | Resolved | Event-driven invalidation; single-call tallies |
| F-07 effect re-fetch loop | Resolved | Query keys by id; no selection copied into state |
| F-08 no tx lifecycle | Resolved | `useTx` state machine; E2E 5 asserts "Confirmed in block N" |
| F-09 vote buttons for everyone | Resolved | Vote action derived from chain; E2E 5–6 |
| F-10 no wrong-chain or stale handling | Resolved | E2E 3, 13–15; manual chain-restart test |
| F-11 connect on load | Resolved | Connect only on button press |
| F-12 accessibility | Resolved | Lighthouse accessibility 100; keyboard-only vote; 360px test |
| F-13 visual system | Resolved | DESIGN.md |
| F-14 debug text in nav | Resolved | Network bar by design |
