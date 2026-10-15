// `npm run lifecycle`: scripted full election lifecycle against a fresh local chain, asserting
// results through the same read paths and error decoder the UI uses (web/src/chain).
//   create -> register batch -> advance -> votes (+ rejected double vote, + rejected unregistered
//   vote) -> end -> finalize -> verify tallies, result, voter status and the audit log.
process.env.OSTRAKON_RPC_PORT ??= "8547";

import assert from "node:assert/strict";
import type { Address } from "viem";

const { account, deploy, publicClient, send, startAnvil } = await import("./lib/chain.ts");
const reads = await import("../web/src/chain/reads.ts");
const { decodeError } = await import("../web/src/chain/errors.ts");
const { ostrakonAbi } = await import("../web/src/generated/ostrakonAbi.ts");

const quietError = console.error;
let passed = 0;
function ok(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
  console.log(`  ✓ ${label}`);
}

async function expectRejected(
  from: number,
  address: Address,
  fn: "vote" | "revealVote" | "commitVote" | "setAllowlist" | "voteWithProof" | "acceptAdmin",
  args: readonly unknown[],
  errorName: string,
) {
  try {
    await publicClient().simulateContract({
      address,
      abi: ostrakonAbi,
      functionName: fn,
      args: args as never,
      account: account(from),
    });
  } catch (err) {
    console.error = () => {}; // decodeError logs the raw error by design; keep this output readable
    const curated = decodeError(err);
    console.error = quietError;
    return { curated, matched: curated.code === errorName };
  }
  return { curated: null, matched: false };
}

const anvil = await startAnvil();
try {
  const pc = publicClient();
  console.log(`▸ fresh anvil on :${process.env.OSTRAKON_RPC_PORT}`);
  const d = await deploy();
  const C = d.address;
  const admin = 1;
  const voters = [2, 3, 4, 5].map((i) => account(i).address);
  console.log(`▸ deployed ${C}`);

  console.log("▸ create");
  await send(C, admin, "createElection", ["Lifecycle Check", ["Ada", "Grace", "Linus"], 0n, 0n]);
  const [e] = await reads.listElections(pc, C);
  ok("listElections returns the new election", e !== undefined && e.name === "Lifecycle Check");
  ok("phase starts at Registration", e!.phase === "Registration");
  ok("creator is admin", e!.admin === account(admin).address);

  console.log("▸ register batch (with a repeat and the zero address)");
  await send(C, admin, "registerVoters", [1n, [...voters, voters[0]!, "0x0000000000000000000000000000000000000000"]]);
  ok("voterCount == 4 (repeat and zero skipped)", (await reads.getElectionDetail(pc, C, 1n)).voterCount === 4);
  ok("getAllVoters lists them in order", (await reads.getAllVoters(pc, C, 1n)).join() === voters.join());

  console.log("▸ advance to Voting");
  await send(C, admin, "advancePhase", [1n]);
  ok("phase is Voting", (await reads.getElectionDetail(pc, C, 1n)).phase === "Voting");

  console.log("▸ votes");
  await send(C, 2, "vote", [1n, 1n]);
  await send(C, 3, "vote", [1n, 1n]);
  await send(C, 4, "vote", [1n, 0n]);

  const dbl = await expectRejected(2, C, "vote", [1n, 0n], "AlreadyVoted");
  ok(`double vote rejected before reaching a wallet: "${dbl.curated?.message}"`, dbl.matched);
  const unreg = await expectRejected(7, C, "vote", [1n, 0n], "NotRegistered");
  ok(`unregistered vote rejected: "${unreg.curated?.message}"`, unreg.matched);
  const badIdx = await expectRejected(5, C, "vote", [1n, 9n], "InvalidCandidate");
  ok(`invalid candidate rejected: "${badIdx.curated?.message}"`, badIdx.matched);

  let detail = await reads.getElectionDetail(pc, C, 1n);
  ok("tallies are [1, 2, 0] after the rejected attempts", detail.tallies.join() === "1,2,0");
  ok("totalVotes == 3", detail.totalVotes === 3);
  ok("voter #2 status: registered and voted", (await reads.getVoterStatus(pc, C, 1n, account(2).address)).voted);
  const s5 = await reads.getVoterStatus(pc, C, 1n, account(5).address);
  ok("voter #5 status: registered, not voted", s5.registered && !s5.voted);
  const statuses = await reads.listVoterStatuses(pc, C, account(7).address);
  ok("account #7 not registered (ledger batch view)", statuses.get(1n)?.registered === false);

  console.log("▸ end + finalize (finalize sent by a non-admin)");
  await send(C, admin, "advancePhase", [1n]);
  await send(C, 7, "finalize", [1n]);
  detail = await reads.getElectionDetail(pc, C, 1n);
  ok("phase Ended and finalized", detail.phase === "Ended" && detail.finalized);
  ok("winner is Grace (index 1), no tie", detail.winner === 1 && !detail.tie);
  ok("leaders() agrees with the contract", reads.leaders(detail.tallies).join() === "1");

  console.log("▸ audit trail");
  const log = await reads.getAuditLog(pc, C, BigInt(d.deployBlock));
  const count = (n: string) => log.filter((l) => l.eventName === n).length;
  ok("1 ElectionCreated", count("ElectionCreated") === 1);
  ok("4 VoterRegistered", count("VoterRegistered") === 4);
  ok("2 PhaseChanged", count("PhaseChanged") === 2);
  ok("3 Voted (rejected attempts left no trace)", count("Voted") === 3);
  ok("1 Finalized", count("Finalized") === 1);
  const mine = await reads.findMyVotes(pc, C, BigInt(d.deployBlock), account(3).address);
  ok("findMyVotes finds exactly voter #3's vote via the indexed topic", mine.length === 1 && mine[0]!.args.candidateIndex === 1n);
  ok("log is in block order", log.every((l, i) => i === 0 || l.blockNumber >= log[i - 1]!.blockNumber));

  // ---------------------------------------------------------------- secret ballot
  console.log("▸ secret ballot: create, register, open");
  await send(C, admin, "createSecretElection", ["Secret Check", ["Ada", "Grace", "Linus"], 0n, 0n, 0n]);
  await send(C, admin, "registerVoters", [2n, voters]);
  await send(C, admin, "advancePhase", [2n]);
  let s = await reads.getElectionDetail(pc, C, 2n);
  ok("secret election is in Voting, flagged secret", s.secret && s.phase === "Voting");

  const choices: Record<number, bigint> = { 2: 2n, 3: 2n, 4: 0n, 5: 1n };
  const salt = (i: number) => `0x${i.toString(16).padStart(2, "0").repeat(32)}` as const;
  for (const i of [2, 3, 4, 5]) {
    const c = reads.commitmentHash(Number(d.chainId), C, 2n, account(i).address, choices[i]!, salt(i));
    await send(C, i, "commitVote", [2n, c]);
  }
  s = await reads.getElectionDetail(pc, C, 2n);
  ok("4 sealed votes, 0 counted, tallies all zero while voting", s.committed === 4 && s.totalVotes === 0 && s.tallies.every((t) => t === 0));
  const early = await expectRejected(2, C, "revealVote", [2n, choices[2], salt(2)], "WrongPhase");
  ok(`reveal during Voting rejected: "${early.curated?.message}"`, early.matched);

  console.log("▸ secret ballot: open reveal");
  await send(C, admin, "advancePhase", [2n]);
  ok("phase is Reveal", (await reads.getElectionDetail(pc, C, 2n)).phase === "Reveal");
  const tampered = await expectRejected(3, C, "revealVote", [2n, 0n, salt(3)], "CommitmentMismatch");
  ok(`reveal with a different choice rejected: "${tampered.curated?.message}"`, tampered.matched);
  const stranger = await expectRejected(7, C, "revealVote", [2n, 0n, salt(7)], "NothingToReveal");
  ok(`reveal without a sealed vote rejected: "${stranger.curated?.message}"`, stranger.matched);
  for (const i of [2, 3, 4]) await send(C, i, "revealVote", [2n, choices[i]!, salt(i)]); // #5 never reveals
  const twice = await expectRejected(2, C, "revealVote", [2n, choices[2], salt(2)], "AlreadyRevealed");
  ok(`second reveal rejected: "${twice.curated?.message}"`, twice.matched);
  const st5 = await reads.getVoterStatus(pc, C, 2n, account(5).address);
  ok("voter #5: committed but not revealed", st5.voted && !st5.revealed);

  console.log("▸ secret ballot: close reveal, finalize");
  await send(C, admin, "advancePhase", [2n]);
  await send(C, 7, "finalize", [2n]);
  s = await reads.getElectionDetail(pc, C, 2n);
  ok("tallies [1, 0, 2]: only revealed votes count", s.tallies.join() === "1,0,2");
  ok("committed 4, counted 3", s.committed === 4 && s.totalVotes === 3);
  ok("winner Linus (index 2)", s.finalized && !s.tie && s.winner === 2);
  const slog = await reads.getAuditLog(pc, C, BigInt(d.deployBlock), { electionId: 2n });
  ok("4 VoteCommitted, 3 Voted events", slog.filter((l) => l.eventName === "VoteCommitted").length === 4 && slog.filter((l) => l.eventName === "Voted").length === 3);
  ok("3 PhaseChanged (Voting, Reveal, Ended)", slog.filter((l) => l.eventName === "PhaseChanged").length === 3);
  const myCommits = await reads.findMyCommits(pc, C, BigInt(d.deployBlock), account(5).address);
  ok("findMyCommits finds #5's sealed vote", myCommits.length === 1 && myCommits[0]!.electionId === 2n);

  // ---------------------------------------------------------------- Merkle allowlist
  console.log("▸ allowlist: 500-address list built with @openzeppelin/merkle-tree (the app's builder)");
  const { buildAllowlist, loadAllowlist, proofFor } = await import("../web/src/lib/allowlist.ts");
  const filler = Array.from({ length: 497 }, (_, i) => `0x${(0x1000 + i).toString(16).padStart(40, "0")}` as Address);
  const listed = [account(2).address, account(3).address, account(4).address, ...filler];
  const built = buildAllowlist(listed);
  const tree = loadAllowlist(built.json)!;
  await send(C, admin, "createElection", ["Allowlist Check", ["Ada", "Grace"], 0n, 0n]);
  await send(C, admin, "setAllowlist", [3n, built.root, "https://example.invalid/list.json"]);
  const al = await reads.getAllowlist(pc, C, 3n);
  ok("root and link read back through getAllowlist", al.root === built.root && al.uri === "https://example.invalid/list.json");
  await send(C, 2, "registerWithProof", [3n, proofFor(tree, account(2).address)!]);
  ok("#2 registered itself during Registration with a JS-built proof", (await reads.getVoterStatus(pc, C, 3n, account(2).address)).registered);
  await send(C, admin, "advancePhase", [3n]);
  const frozen = await expectRejected(admin, C, "setAllowlist", [3n, built.root, ""], "WrongPhase");
  ok(`allowlist frozen once voting opens: "${frozen.curated?.message}"`, frozen.matched);
  await send(C, 3, "voteWithProof", [3n, 1n, proofFor(tree, account(3).address)!]);
  ok("#3 registered and voted in one transaction", (await reads.getVoterStatus(pc, C, 3n, account(3).address)).voted);
  const outsider = await expectRejected(7, C, "voteWithProof", [3n, 0n, proofFor(tree, account(4).address)!], "NotOnAllowlist");
  ok(`outsider using a member's proof rejected: "${outsider.curated?.message}"`, outsider.matched);
  await send(C, 2, "vote", [3n, 0n]); // already registered: plain vote works
  const al3 = await reads.getElectionDetail(pc, C, 3n);
  ok("voterCount counts only claimed members (2 of 500)", al3.voterCount === 2 && al3.tallies.join() === "1,1");

  // ---------------------------------------------------------------- two-step admin
  console.log("▸ two-step admin hand-over");
  await send(C, admin, "transferAdmin", [3n, account(5).address]);
  let e3 = await reads.getElectionDetail(pc, C, 3n);
  ok("nomination leaves the admin unchanged", e3.admin === account(admin).address && e3.pendingAdmin === account(5).address);
  const wrongAccept = await expectRejected(6, C, "acceptAdmin", [3n], "NotPendingAdmin");
  ok(`only the nominee can accept: "${wrongAccept.curated?.message}"`, wrongAccept.matched);
  await send(C, 5, "acceptAdmin", [3n]);
  e3 = await reads.getElectionDetail(pc, C, 3n);
  ok("nominee accepted and is now admin", e3.admin === account(5).address && e3.pendingAdmin === "0x0000000000000000000000000000000000000000");

  console.log(`\nlifecycle: ${passed} assertions passed`);
} catch (err) {
  console.error("\nlifecycle FAILED:", err);
  process.exitCode = 1;
} finally {
  anvil.kill();
}
