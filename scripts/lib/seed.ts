// Seeds a demo world: five elections across every phase, with demo voters in different states.
import type { Address } from "viem";
import { account, publicClient, send } from "./chain.ts";

export const ROLES: Record<number, string> = {
  0: "Admin of #1 Student Council, #3 Robotics Club, #5 Hostel Mess (deployer)",
  1: "Admin of #2 Library Hours, #4 Cultural Fest",
  2: "Voter: voted #1, #3, #4 · registered #2, #5",
  3: "Voter: voted #1, #3, #4 · registered #2, #5",
  4: "Voter: voted #1, #3 · registered #5",
  5: "Voter: registered #1 (not voted), voted #3",
  6: "Voter: registered #1 (not voted)",
  7: "Not registered anywhere (use to see the read-only / ineligible states)",
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
}
