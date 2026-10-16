# Stack decisions

Each choice below says what I picked, why, and what I rejected.

**Contracts: Solidity 0.8.30 (`pragma ^0.8.24`) with Foundry.**
Foundry has first-class fuzz and invariant testing (`forge test`), coverage, gas snapshots, `forge fmt`, `forge lint`, and Anvil, all in one toolchain, with the tests written in Solidity next to the code. Hardhat 2 needs a JS test harness and plugins for the same things, and its managed artifact directory prunes files it doesn't own, which makes it easy to lose a deployment file. Hardhat 3 has Solidity tests, but Foundry's invariant tooling is more mature, and Slither supports Foundry projects directly.
**Cost:** Foundry is a native binary, so it's one prerequisite (`foundryup`) on top of Node. `scripts/lib/foundry.ts` finds it on `PATH` or in `~/.foundry/bin` and prints install instructions if it's missing.

**Solidity dependencies: forge-std as a pinned HTTPS tarball in `package.json`.**
`npm install` fetches everything, with an integrity hash in the lockfile, so a clone needs no `git submodule` step. I rejected `forge install` (git submodules: easy to forget `--recursive`), the `forge-std` npm package (stale at 1.1.2), and a `github:` dependency (npm wrote a `git+ssh` URL into the lockfile, which breaks for anyone without GitHub SSH keys).

**OpenZeppelin: only `MerkleProof` on chain, and its partner `@openzeppelin/merkle-tree` in the browser.**
The contract has no tokens, no ether, and no external calls. Per-election admin replaces `Ownable` (a single global owner), and the two-step hand-over is written directly against that per-election model, so nothing else from OZ earns its place. The Merkle allowlist is the exception: proof verification is easy to get subtly wrong (leaf/node domain separation, sorted pairs), so it uses OZ's audited `MerkleProof.verifyCalldata`. The app builds trees with OZ's `StandardMerkleTree` JS library, whose double-hashed leaf format is exactly what the contract checks. That pairing is the tested contract between browser and chain, and admins can produce compatible trees with OZ's own tooling. The JS library is loaded lazily (a 36 kB gzipped chunk), only on allowlisted elections and the admin panel.
I rejected a hand-rolled tree: it would need its own proof format and its own audit.

**Local chain: Anvil.**
It starts quickly, uses a deterministic mnemonic (so the contract always lands at the same address on a fresh chain), and supports `evm_setIntervalMining`. The dev script seeds with instant mining, then switches to a 2 s block time so confirmations visibly count up, like a real network. Its WebSocket endpoint enables push event subscriptions. I rejected the Hardhat node because it would add a second toolchain.

**Frontend: Vite 8 + React 19 + TypeScript 6.**
The app is a static SPA that reads a chain. It needs no server rendering, API routes, or SEO, so Next.js would add a server runtime and build complexity for nothing. Vite builds a static `dist/` that can be hosted anywhere, IPFS included. I pinned TypeScript 6.0 because `typescript-eslint` doesn't support TS 7 yet.

**Chain access: viem directly, wagmi only for wallets.**
- All reads go through framework-agnostic functions (`web/src/chain/reads.ts`) on a viem `PublicClient`, with typed ABIs generated from forge output. `scripts/lifecycle.ts` runs the very same functions, so the scripted verification asserts through the UI's read paths.
- wagmi 3 handles the parts that are tedious and error-prone to hand-roll: connector lifecycle, EIP-6963 multi-wallet discovery, `accountsChanged` and `chainChanged` subscriptions with cleanup, and switch-or-add-chain.
- Its `mock` connector is the basis of the test-only wallet.
- I rejected RainbowKit, ConnectKit, and Web3Modal: they impose their own modal look, and the brief asks for our own connect UI.
- I rejected web3.js: it's heavy (web3.js 1.x adds roughly 400 kB gzipped), untyped ABIs, and a weaker API.

**Data fetching: TanStack Query.**
It's already a wagmi peer dependency. Query keys sit under one `["ostrakon", address, chainId]` prefix, and every contract event invalidates that prefix. The UI derives everything from these queries instead of copying chain data into local state.

**Live data: `watchContractEvent` over WebSocket, falling back to polling, plus one block-number poll.**
- Events arrive pushed. If the socket fails, the watcher restarts in polling mode.
- A once-per-second `eth_blockNumber` drives the network bar, confirmation counts, and chain-reset detection (the block number going backwards means anvil restarted).
- There is no per-candidate or per-election polling. Tallies come from one `getTallies` call, and the ledger from one `getElections` plus one `getVoterStatuses` call.

**Indexing: direct `getLogs`, no indexer.**
The audit screen reads all contract logs from the deploy block and decodes them with the ABI. That's instant on a local chain. I rejected The Graph, Ponder, and similar indexers: they add a service to run, and at this scale they don't improve the audit screen. A public deployment with a long history would want one (see README, future scope).

**Sign-In with Ethereum: not used.**
There's no server session to authenticate. Every authorization decision is made by the contract from `msg.sender`, so SIWE would add a ceremony with no security benefit.

**Motion: no library. About 200 lines of hooks on IntersectionObserver, `requestAnimationFrame` and one passive scroll listener (`web/src/components/motion.tsx`).**
- My first build used the `motion` package (Framer Motion's successor). Measuring the production bundle showed the motion packages were the largest dependency I controlled. Replacing the five primitives I actually used cut the main bundle from 253 kB to 202 kB gzipped, with identical behavior. That's before route splitting. The E2E suite passed both before and after.
- Everything animates only `transform` and `opacity`. The scroll-linked rail reads `getBoundingClientRect` at most once per frame and writes a transform. `prefers-reduced-motion` switches every effect to a static render.
- I rejected CSS scroll-driven animations because they still aren't consistent across all major browsers.
- I rejected GSAP ScrollTrigger: it's another large dependency for one effect.
- I rejected Lenis: smooth-scroll hijacks native and keyboard scrolling, which the brief forbids.

**Fonts: self-hosted through `@fontsource`.**
Vite bundles the font files into `dist/`, so the app makes no third-party font requests. See DESIGN.md for the choices.

**Testing:**
- Foundry for contract unit, fuzz, and invariant tests.
- Vitest for pure frontend logic (`decodeError`, receipts, allowlists, wallet choice, replacement handling).
- Playwright for the browser run against a `VITE_E2E=1` build, which adds the mock connector. Projects: installed Chrome, Firefox, WebKit, Pixel 7 (Chrome) and iPhone 14 (WebKit). Each project gets a freshly seeded chain.
- I rejected Cypress: Playwright drives Chromium, Firefox, and WebKit headless with less setup, and has a better trace viewer.
- Lighthouse CLI (`npx lighthouse@12.6.0`) for performance on the production build. The DevTools Lighthouse panel omits the performance category's per-element layout-shift detail, which was needed to find a mobile CLS bug.

**Static analysis: Slither, plus `forge lint -D warnings`.**
`forge lint` runs as a separate gate (`npm run lint:sol`), and any remaining lint is triaged inline with the reason. Slither isn't an npm dependency because it's Python. VERIFICATION.md shows the exact command, and SECURITY.md triages every finding.
