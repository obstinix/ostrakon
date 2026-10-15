// The one place errors become user-facing copy. Raw messages never reach the DOM:
// contract custom errors are mapped by NAME (from the typed ABI), everything else is classified
// by viem error type, and anything unrecognised gets a generic line.
import {
  BaseError,
  ContractFunctionRevertedError,
  HttpRequestError,
  InsufficientFundsError,
  TimeoutError,
  UserRejectedRequestError,
  WebSocketRequestError,
} from "viem";
import { PHASES } from "./reads";

export interface Curated {
  /** Short sentence safe to render. */
  message: string;
  /** Stable code for tests and analytics; never shown raw. */
  code: string;
}

const phase = (v: unknown) => (typeof v === "number" && PHASES[v]) || "another";
const nth = (v: unknown) => (typeof v === "bigint" ? `#${(v + 1n).toString()}` : "");
const when = (v: unknown) =>
  typeof v === "bigint" ? new Date(Number(v) * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "its scheduled time";

type ArgsMapper = (args: readonly unknown[]) => string;

export const CONTRACT_ERROR_COPY: Record<string, ArgsMapper> = {
  ElectionNotFound: () => "That election does not exist on this contract.",
  NotAdmin: () => "Only this election's admin can do that.",
  WrongPhase: ([, expected, actual]) =>
    `That needs the ${phase(expected)} phase, but the election is in ${phase(actual)}.`,
  EmptyElectionName: () => "Give the election a name.",
  ElectionNameTooLong: () => "Election names can be at most 80 bytes.",
  CandidateCountOutOfRange: () => "An election needs between 2 and 32 candidates.",
  EmptyCandidateName: ([i]) => `Candidate ${nth(i)} has no name.`,
  CandidateNameTooLong: ([i]) => `Candidate ${nth(i)}'s name is longer than 64 bytes.`,
  DuplicateCandidate: ([a, b]) => `Candidates ${nth(a)} and ${nth(b)} have the same name.`,
  InvalidSchedule: () => "The voting window must end in the future, and after it starts.",
  ScheduleNotReached: ([at]) => `This election runs on a schedule. That step unlocks at ${when(at)}.`,
  ZeroAddress: () => "The zero address can't be used here.",
  AlreadyRegistered: () => "That address is already registered.",
  EmptyBatch: () => "Add at least one address.",
  BatchTooLarge: () => "At most 200 addresses fit in one transaction.",
  NotRegistered: () => "This account is not registered for this election.",
  AlreadyVoted: () => "This account has already voted in this election.",
  InvalidCandidate: () => "That candidate does not exist.",
  AlreadyFinalized: () => "The result has already been finalized.",
  PageTooLarge: () => "That request asked for too much at once.",
  SecretBallot: () => "This is a secret ballot: seal your vote instead of casting it openly.",
  NotSecretBallot: () => "This election uses open ballots; there is nothing to seal or reveal.",
  EmptyCommitment: () => "The sealed vote was empty. Nothing was sent.",
  NothingToReveal: () => "This account has no sealed vote to reveal in this election.",
  AlreadyRevealed: () => "This vote has already been revealed and counted.",
  CommitmentMismatch: () =>
    "That receipt doesn't match the sealed vote on chain. Check that it is the receipt for this account and election.",
};

export const GENERIC: Curated = { code: "unknown", message: "Something went wrong. Nothing was changed." };

export function decodeError(err: unknown): Curated {
  console.error("[ostrakon]", err);

  if (err instanceof BaseError) {
    const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) {
      const name = revert.data?.errorName;
      if (name && name in CONTRACT_ERROR_COPY) {
        return { code: name, message: CONTRACT_ERROR_COPY[name]!(revert.data?.args ?? []) };
      }
      return { code: "revert", message: "The contract rejected this transaction. Nothing was changed." };
    }
    if (err.walk((e) => e instanceof UserRejectedRequestError) || hasCode(err, 4001)) {
      return { code: "rejected", message: "You cancelled the request in your wallet." };
    }
    if (hasCode(err, -32002)) {
      return { code: "pending-request", message: "Your wallet already has a request open. Open the wallet to continue." };
    }
    if (err.walk((e) => e instanceof InsufficientFundsError)) {
      return { code: "funds", message: "This account doesn't have enough ETH to pay for gas." };
    }
    if (err.walk((e) => e instanceof HttpRequestError || e instanceof WebSocketRequestError || e instanceof TimeoutError)) {
      return { code: "network", message: "Couldn't reach the chain. Check that the local node is running." };
    }
  }
  if (hasCode(err, 4001)) return { code: "rejected", message: "You cancelled the request in your wallet." };
  return GENERIC;
}

function hasCode(err: unknown, code: number): boolean {
  let cur: unknown = err;
  for (let depth = 0; cur && depth < 8; depth++) {
    if (typeof cur === "object" && cur !== null && "code" in cur && (cur as { code: unknown }).code === code) return true;
    cur = typeof cur === "object" && cur !== null && "cause" in cur ? (cur as { cause: unknown }).cause : undefined;
  }
  return false;
}
