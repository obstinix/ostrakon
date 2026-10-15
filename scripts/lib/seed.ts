// Seeds a demo world: seven elections across every phase, both ballot modes and a Merkle
// allowlist, with demo voters in different states.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAddress, keccak256, toHex, type Address } from "viem";
import { buildAllowlist } from "../../web/src/lib/allowlist.ts";
import { commitmentHash } from "../../web/src/chain/reads.ts";
import { account, CHAIN_ID, publicClient, send } from "./chain.ts";

export const ROLES: Record<number, string> = {
  0: "Admin of #1 Student Council, #3 Robotics Club, #5 Hostel Mess, #6 Sports Captain, #7 Alumni Board (deployer)",
  1: "Admin of #2 Library Hours, #4 Cultural Fest",
  2: "Voter: voted #1, #3, #4 · sealed a secret vote in #6 · registered #2, #5",
  3: "Voter: voted #1, #3, #4 · sealed a secret vote in #6 · registered #2, #5",
  4: "Voter: voted #1, #3 · registered #5 · can seal a secret vote in #6 · on the #7 allowlist",
  5: "Voter: registered #1 (not voted), voted #3 · can seal a secret vote in #6 · on the #7 allowlist",
  6: "Voter: registered #1 (not voted) · on the #7 allowlist",
  7: "Not registered or listed anywhere (use to see the read-only / ineligible states)",
};

const addr = (i: number): Address => account(i).address;
const many = (...ix: number[]) => ix.map(addr);

export async function seed(contract: Address): Promise<void> {
  const now = (await publicClient().getBlock()).timestamp;

  // #1 Voting, live: 3 of 5 voted.
  await send(contract, 0, "createElection", [
    "Student Council 2026",
    ["Ananya Kulkarni", "Rahul Deshmukh", "Sneha Jadhav"],
    0n,
    0n,
  ]);
  await send(contract, 0, "registerVoters", [1n, many(2, 3, 4, 5, 6)]);
  await send(contract, 0, "advancePhase", [1n]);
  await send(contract, 2, "vote", [1n, 1n]);
  await send(contract, 3, "vote", [1n, 1n]);
  await send(contract, 4, "vote", [1n, 0n]);

  // #2 Registration, admin = account 1.
  await send(contract, 1, "createElection", [
    "Library Hours Referendum",
    ["Extend to 22:00", "Keep 20:00"],
    0n,
    0n,
  ]);
  await send(contract, 1, "registerVoters", [2n, many(2, 3)]);

  // #3 Ended + finalized with a clear winner.
  await send(contract, 0, "createElection", [
    "Robotics Club Lead",
    ["Ishaan Rao", "Meera Pillai", "Kabir Shah", "Tara Nair"],
    0n,
    0n,
  ]);
  await send(contract, 0, "registerVoters", [3n, many(2, 3, 4, 5)]);
  await send(contract, 0, "advancePhase", [3n]);
  await send(contract, 2, "vote", [3n, 1n]);
  await send(contract, 3, "vote", [3n, 1n]);
  await send(contract, 4, "vote", [3n, 3n]);
  await send(contract, 5, "vote", [3n, 1n]);
  await send(contract, 0, "advancePhase", [3n]);
  await send(contract, 7, "finalize", [3n]); // anyone can finalize

  // #4 Ended + finalized as a tie.
  await send(contract, 1, "createElection", ["Cultural Fest Theme", ["Monsoon Folk", "Retro Arcade"], 0n, 0n]);
  await send(contract, 1, "registerVoters", [4n, many(2, 3)]);
  await send(contract, 1, "advancePhase", [4n]);
  await send(contract, 2, "vote", [4n, 0n]);
  await send(contract, 3, "vote", [4n, 1n]);
  await send(contract, 1, "advancePhase", [4n]);
  await send(contract, 1, "finalize", [4n]);

  // #5 Scheduled: voting opens in 10 minutes, closes in 2 days.
  await send(contract, 0, "createElection", [
    "Hostel Mess Committee",
    ["Priya Menon", "Arjun Kale", "Fatima Shaikh"],
    now + 600n,
    now + 2n * 86_400n,
  ]);
  await send(contract, 0, "registerVoters", [5n, many(2, 3, 4)]);

  // #6 Secret ballot (commit-reveal) in Voting: #2 and #3 have sealed votes; #4 and #5 can seal theirs.
  // Demo salts are derived from a fixed string, so these two sealed votes stay sealed in the UI
  // (their receipts live only here). Real voters get random salts from the app.
  await send(contract, 0, "createSecretElection", [
    "Sports Captain (secret ballot)",
    ["Devika Rane", "Omkar Joshi", "Neha Bhosale"],
    0n,
    0n,
    0n,
  ]);
  await send(contract, 0, "registerVoters", [6n, many(2, 3, 4, 5)]);
  await send(contract, 0, "advancePhase", [6n]);
  for (const [who, choice] of [
    [2, 0n],
    [3, 2n],
  ] as const) {
    const salt = keccak256(toHex(`ostrakon-demo-seed-${who}`));
    await send(contract, who, "commitVote", [6n, commitmentHash(CHAIN_ID, contract, 6n, addr(who), choice, salt)]);
  }

  // #7 Open ballot with a Merkle allowlist of 1,003 addresses (#4, #5, #6 plus 1,000 generated ones),
  // in Voting. Nobody is registered yet: listed voters register in the same transaction as their vote.
  // The tree is served by the app at /allowlists/7.json, the link published on chain.
  await send(contract, 0, "createElection", ["Alumni Board (allowlist)", ["Rohan Iyer", "Asha Kulkarni"], 0n, 0n]);
  const list = writeDemoAllowlist();
  await send(contract, 0, "setAllowlist", [7n, list.root, "/allowlists/7.json"]);
  await send(contract, 0, "advancePhase", [7n]);
}

export const DEMO_ALLOWLIST_FILE = join(dirname(fileURLToPath(import.meta.url)), "../../web/public/allowlists/7.json");

/** Build the demo allowlist for election #7 (deterministic) and write the file the app serves. */
export function writeDemoAllowlist(): { root: `0x${string}`; json: string } {
  const generated = Array.from({ length: 1000 }, (_, i) =>
    getAddress(`0x${keccak256(toHex(`ostrakon-demo-alumnus-${i}`)).slice(26)}`),
  );
  const list = buildAllowlist([...many(4, 5, 6), ...generated]);
  mkdirSync(dirname(DEMO_ALLOWLIST_FILE), { recursive: true });
  writeFileSync(DEMO_ALLOWLIST_FILE, list.json);
  return list;
}
