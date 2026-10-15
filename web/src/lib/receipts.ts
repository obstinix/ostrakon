// Secret-ballot receipts: the (choice, salt) a voter needs to reveal a sealed vote later.
// Kept in this browser's localStorage and offered as a downloadable file, because if both are
// lost the vote can never be revealed or counted. Nothing here is ever sent to a server.
import { isAddress, isHex, type Address, type Hex } from "viem";

export interface Receipt {
  v: 1;
  chainId: number;
  contract: Address;
  electionId: string; // decimal
  voter: Address;
  candidateIndex: number;
  salt: Hex;
  commitment: Hex;
}

const key = (chainId: number, contract: string, electionId: bigint, voter: string) =>
  `ostrakon:receipt:${chainId}:${contract.toLowerCase()}:${electionId.toString()}:${voter.toLowerCase()}`;

export function newSalt(): Hex {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return `0x${[...b].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
}

export function saveReceipt(r: Receipt): void {
  try {
    localStorage.setItem(key(r.chainId, r.contract, BigInt(r.electionId), r.voter), JSON.stringify(r));
  } catch (err) {
    console.error("[ostrakon] could not store receipt", err);
  }
}

export function loadReceipt(chainId: number, contract: string, electionId: bigint, voter: string): Receipt | null {
  try {
    const raw = localStorage.getItem(key(chainId, contract, electionId, voter));
    return raw ? parseReceipt(raw) : null;
  } catch (err) {
    console.error("[ostrakon] could not read receipt", err);
    return null;
  }
}

/** Parse and shape-check receipt JSON (from storage or pasted by the voter). */
export function parseReceipt(text: string): Receipt | null {
  try {
    const r = JSON.parse(text) as Partial<Receipt>;
    if (
      r.v !== 1 ||
      typeof r.chainId !== "number" ||
      typeof r.contract !== "string" ||
      !isAddress(r.contract) ||
      typeof r.electionId !== "string" ||
      !/^\d+$/.test(r.electionId) ||
      typeof r.voter !== "string" ||
      !isAddress(r.voter) ||
      typeof r.candidateIndex !== "number" ||
      !Number.isInteger(r.candidateIndex) ||
      r.candidateIndex < 0 ||
      typeof r.salt !== "string" ||
      !isHex(r.salt) ||
      r.salt.length !== 66 ||
      typeof r.commitment !== "string" ||
      !isHex(r.commitment) ||
      r.commitment.length !== 66
    ) {
      return null;
    }
    return r as Receipt;
  } catch {
    return null;
  }
}

/** Offer the receipt as a file the voter saves themselves. */
export function downloadReceipt(r: Receipt): void {
  const blob = new Blob([JSON.stringify(r, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `ostrakon-receipt-election-${r.electionId}-${r.voter.slice(0, 8)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
