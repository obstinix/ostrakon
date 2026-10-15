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

async function expectRejected(from: number, address: Address, fn: "vote", args: readonly unknown[], errorName: string) {
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
  let [e] = await reads.listElections(pc, C);
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

  console.log(`\nlifecycle: ${passed} assertions passed`);
} catch (err) {
  console.error("\nlifecycle FAILED:", err);
  process.exitCode = 1;
} finally {
  anvil.kill();
}
