// Merkle allowlists in the OpenZeppelin StandardMerkleTree format, the same format the contract's
// `MerkleProof` check expects (leaf = keccak256(bytes.concat(keccak256(abi.encode(address))))).
// Import this module lazily: only the admin's allowlist panel and allowlisted elections need it.
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { getAddress, isAddress, type Address, type Hex } from "viem";

export type AllowlistTree = StandardMerkleTree<[string]>;

export interface BuiltAllowlist {
  root: Hex;
  size: number;
  /** JSON the admin publishes so voters can derive proofs. */
  json: string;
}

export function buildAllowlist(addresses: readonly Address[]): BuiltAllowlist {
  if (addresses.length === 0) throw new Error("empty allowlist");
  const tree = StandardMerkleTree.of(
    addresses.map((a) => [getAddress(a)] as [string]),
    ["address"],
  );
  return { root: tree.root as Hex, size: tree.length, json: JSON.stringify(tree.dump()) };
}

/** Parse a published tree. Returns null for anything that isn't a valid address allowlist. */
export function loadAllowlist(text: string): AllowlistTree | null {
  try {
    const data = JSON.parse(text) as { format?: unknown; leafEncoding?: unknown };
    if (data.format !== "standard-v1") return null;
    if (!Array.isArray(data.leafEncoding) || data.leafEncoding.length !== 1 || data.leafEncoding[0] !== "address") {
      return null;
    }
    const tree = StandardMerkleTree.load(data as never) as AllowlistTree;
    tree.validate(); // recomputes every hash: a tampered file is rejected here
    return tree;
  } catch {
    return null;
  }
}

/** The proof for `voter`, or null if the address isn't in the tree. */
export function proofFor(tree: AllowlistTree, voter: Address): Hex[] | null {
  for (const [i, [a]] of tree.entries()) {
    if (isAddress(a) && a.toLowerCase() === voter.toLowerCase()) return tree.getProof(i) as Hex[];
  }
  return null;
}

export function verifyMember(root: Hex, voter: Address, proof: readonly Hex[]): boolean {
  try {
    return StandardMerkleTree.verify(root, ["address"], [getAddress(voter)], [...proof]);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- per-browser cache

const key = (chainId: number, contract: string, electionId: bigint) =>
  `ostrakon:allowlist:${chainId}:${contract.toLowerCase()}:${electionId.toString()}`;

export function saveTree(chainId: number, contract: string, electionId: bigint, json: string): void {
  try {
    localStorage.setItem(key(chainId, contract, electionId), json);
  } catch (err) {
    console.error("[ostrakon] could not store allowlist", err);
  }
}

export function loadSavedTree(chainId: number, contract: string, electionId: bigint): string | null {
  try {
    return localStorage.getItem(key(chainId, contract, electionId));
  } catch {
    return null;
  }
}

export function downloadTree(electionId: bigint, json: string): void {
  const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `ostrakon-allowlist-election-${electionId.toString()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
