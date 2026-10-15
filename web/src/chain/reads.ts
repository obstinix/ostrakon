// Framework-agnostic read paths. The React app and scripts/lifecycle.ts both use these,
// so the scripted verification exercises exactly what the UI renders.
import {
  encodeAbiParameters,
  keccak256,
  parseEventLogs,
  type Address,
  type Hash,
  type Hex,
  type PublicClient,
} from "viem";
import { ostrakonAbi } from "../generated/ostrakonAbi";

/** Contract enum order. Open ballots never use "Reveal". */
export const PHASES = ["Registration", "Voting", "Reveal", "Ended"] as const;
export type PhaseName = (typeof PHASES)[number];
export const PAGE = 100n;

/** The phases this election actually goes through, in order. */
export function phasesFor(e: { secret: boolean }): readonly PhaseName[] {
  return e.secret ? PHASES : (["Registration", "Voting", "Ended"] as const);
}

/** Position of the election's current phase within its own phase list (0-based). */
export function phaseStep(e: { secret: boolean; phase: PhaseName }): number {
  return phasesFor(e).indexOf(e.phase);
}

export interface ElectionSummary {
  id: bigint;
  admin: Address;
  name: string;
  phase: PhaseName;
  /** Contract enum value: 0 Registration, 1 Voting, 2 Reveal, 3 Ended. */
  phaseIndex: 0 | 1 | 2 | 3;
  votingStart: bigint;
  votingEnd: bigint;
  createdBlock: bigint;
  candidateCount: number;
  voterCount: number;
  /** Counted votes: cast (open ballot) or revealed (secret ballot). */
  totalVotes: number;
  finalized: boolean;
  tie: boolean;
  winner: number;
  secret: boolean;
  revealEnd: bigint;
  /** Secret ballot: sealed votes submitted during Voting. Always 0 for open ballots. */
  committed: number;
}

export interface ElectionDetail extends ElectionSummary {
  candidates: string[];
  tallies: number[];
}

export interface VoterStatus {
  registered: boolean;
  /** Open ballot: voted. Secret ballot: committed a sealed vote. */
  voted: boolean;
  /** Secret ballot: revealed (and therefore counted). */
  revealed: boolean;
}

type RawView = {
  id: bigint;
  admin: Address;
  name: string;
  phase: number;
  votingStart: bigint;
  votingEnd: bigint;
  createdBlock: bigint;
  candidateCount: bigint;
  voterCount: bigint;
  totalVotes: bigint;
  finalized: boolean;
  tie: boolean;
  winner: number;
  secret: boolean;
  revealEnd: bigint;
  committed: bigint;
};

export function toSummary(v: RawView): ElectionSummary {
  const phaseIndex = v.phase as 0 | 1 | 2 | 3;
  return {
    id: v.id,
    admin: v.admin,
    name: v.name,
    phase: PHASES[phaseIndex],
    phaseIndex,
    votingStart: v.votingStart,
    votingEnd: v.votingEnd,
    createdBlock: v.createdBlock,
    candidateCount: Number(v.candidateCount),
    voterCount: Number(v.voterCount),
    totalVotes: Number(v.totalVotes),
    finalized: v.finalized,
    tie: v.tie,
    winner: v.winner,
    secret: v.secret,
    revealEnd: v.revealEnd,
    committed: Number(v.committed),
  };
}

/** All elections, newest first. One `getElections` call per 100 elections. */
export async function listElections(client: PublicClient, address: Address): Promise<ElectionSummary[]> {
  const count = await client.readContract({ address, abi: ostrakonAbi, functionName: "electionCount" });
  const pages: Promise<readonly RawView[]>[] = [];
  for (let offset = 0n; offset < count; offset += PAGE) {
    pages.push(
      client.readContract({ address, abi: ostrakonAbi, functionName: "getElections", args: [offset, PAGE] }),
    );
  }
  const all = (await Promise.all(pages)).flat().map(toSummary);
  return all.reverse();
}

/** Registered/voted/revealed flags for `voter` across all elections, keyed by election id. */
export async function listVoterStatuses(
  client: PublicClient,
  address: Address,
  voter: Address,
): Promise<Map<bigint, VoterStatus>> {
  const count = await client.readContract({ address, abi: ostrakonAbi, functionName: "electionCount" });
  const out = new Map<bigint, VoterStatus>();
  const jobs: Promise<void>[] = [];
  for (let offset = 0n; offset < count; offset += PAGE) {
    const start = offset;
    jobs.push(
      client
        .readContract({ address, abi: ostrakonAbi, functionName: "getVoterStatuses", args: [voter, start, PAGE] })
        .then(([reg, voted, revealed]) => {
          reg.forEach((r, i) =>
            out.set(start + BigInt(i) + 1n, {
              registered: r,
              voted: voted[i] ?? false,
              revealed: revealed[i] ?? false,
            }),
          );
        }),
    );
  }
  await Promise.all(jobs);
  return out;
}

/** Summary, candidate names and all tallies (three reads, issued in parallel). */
export async function getElectionDetail(client: PublicClient, address: Address, id: bigint): Promise<ElectionDetail> {
  const [view, candidates, tallies] = await Promise.all([
    client.readContract({ address, abi: ostrakonAbi, functionName: "getElection", args: [id] }),
    client.readContract({ address, abi: ostrakonAbi, functionName: "getCandidates", args: [id] }),
    client.readContract({ address, abi: ostrakonAbi, functionName: "getTallies", args: [id] }),
  ]);
  return { ...toSummary(view), candidates: [...candidates], tallies: tallies.map(Number) };
}

export async function getVoterStatus(
  client: PublicClient,
  address: Address,
  id: bigint,
  voter: Address,
): Promise<VoterStatus> {
  const [registered, voted, revealed] = await Promise.all([
    client.readContract({ address, abi: ostrakonAbi, functionName: "isRegistered", args: [id, voter] }),
    client.readContract({ address, abi: ostrakonAbi, functionName: "hasVoted", args: [id, voter] }),
    client.readContract({ address, abi: ostrakonAbi, functionName: "hasRevealed", args: [id, voter] }),
  ]);
  return { registered, voted, revealed };
}

/** The sealed commitment `voter` submitted (zero hash if none). Public data. */
export async function getCommitment(client: PublicClient, address: Address, id: bigint, voter: Address): Promise<Hex> {
  return client.readContract({ address, abi: ostrakonAbi, functionName: "commitmentOf", args: [id, voter] });
}

/**
 * The commitment for a secret vote, computed locally. Must match the contract:
 * keccak256(abi.encode(chainId, contract, electionId, voter, candidateIndex, salt)).
 * Never ask a node to compute this: that would tell the node the choice.
 */
export function commitmentHash(
  chainId: number,
  contract: Address,
  electionId: bigint,
  voter: Address,
  candidateIndex: bigint,
  salt: Hex,
): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "uint256" },
        { type: "address" },
        { type: "uint256" },
        { type: "address" },
        { type: "uint256" },
        { type: "bytes32" },
      ],
      [BigInt(chainId), contract, electionId, voter, candidateIndex, salt],
    ),
  );
}

/** Every registered voter, paginated 100 at a time. */
export async function getAllVoters(client: PublicClient, address: Address, id: bigint): Promise<Address[]> {
  const total = await client.readContract({ address, abi: ostrakonAbi, functionName: "voterCount", args: [id] });
  const pages: Promise<readonly Address[]>[] = [];
  for (let offset = 0n; offset < total; offset += PAGE) {
    pages.push(client.readContract({ address, abi: ostrakonAbi, functionName: "getVoters", args: [id, offset, PAGE] }));
  }
  return (await Promise.all(pages)).flat();
}

// ------------------------------------------------------------------ audit log

export type OstrakonEventName =
  | "ElectionCreated"
  | "VoterRegistered"
  | "PhaseChanged"
  | "Voted"
  | "VoteCommitted"
  | "Finalized"
  | "AdminTransferred";

export interface AuditEntry {
  key: string;
  eventName: OstrakonEventName;
  electionId: bigint;
  blockNumber: bigint;
  logIndex: number;
  txHash: Hash;
  args: Record<string, unknown>;
}

export function decodeLogs(logs: Parameters<typeof parseEventLogs>[0]["logs"]): AuditEntry[] {
  const parsed = parseEventLogs({ abi: ostrakonAbi, logs, strict: true });
  return parsed
    .filter((l) => l.blockNumber !== null && l.transactionHash !== null && l.logIndex !== null)
    .map((l) => {
      const args = l.args as Record<string, unknown> & { electionId: bigint };
      return {
        key: `${l.transactionHash}:${l.logIndex}`,
        eventName: l.eventName as OstrakonEventName,
        electionId: args.electionId,
        blockNumber: l.blockNumber!,
        logIndex: l.logIndex!,
        txHash: l.transactionHash!,
        args,
      };
    });
}

/** All contract events from `fromBlock`, oldest first. */
export async function getAuditLog(
  client: PublicClient,
  address: Address,
  fromBlock: bigint,
  filter?: { electionId?: bigint },
): Promise<AuditEntry[]> {
  const logs = await client.getLogs({ address, fromBlock, toBlock: "latest" });
  const entries = decodeLogs(logs);
  const filtered = filter?.electionId === undefined ? entries : entries.filter((e) => e.electionId === filter.electionId);
  return filtered.sort((a, b) =>
    a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1,
  );
}

/** The `Voted` record(s) for one voter, using the indexed `voter` topic. */
export async function findMyVotes(
  client: PublicClient,
  address: Address,
  fromBlock: bigint,
  voter: Address,
): Promise<AuditEntry[]> {
  const votedEvent = ostrakonAbi.find((x) => x.type === "event" && x.name === "Voted");
  if (!votedEvent || votedEvent.type !== "event") throw new Error("Voted event missing from ABI");
  const logs = await client.getLogs({ address, event: votedEvent, args: { voter }, fromBlock, toBlock: "latest" });
  return decodeLogs(logs);
}

/** The `VoteCommitted` (sealed vote) record(s) for one voter. */
export async function findMyCommits(
  client: PublicClient,
  address: Address,
  fromBlock: bigint,
  voter: Address,
): Promise<AuditEntry[]> {
  const ev = ostrakonAbi.find((x) => x.type === "event" && x.name === "VoteCommitted");
  if (!ev || ev.type !== "event") throw new Error("VoteCommitted event missing from ABI");
  const logs = await client.getLogs({ address, event: ev, args: { voter }, fromBlock, toBlock: "latest" });
  return decodeLogs(logs);
}

// ------------------------------------------------------------------ derived

/** Share of total, 0..1. */
export function share(tally: number, total: number): number {
  return total === 0 ? 0 : tally / total;
}

/** Indices of the top-tally candidates (more than one means a tie). */
export function leaders(tallies: number[]): number[] {
  const max = Math.max(...tallies);
  return tallies.flatMap((t, i) => (t === max ? [i] : []));
}
