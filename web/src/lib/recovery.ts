// Wallet-recoverable secret-ballot receipts.
// The salt for a sealed vote is keccak256(signature over a fixed, election-specific message).
// ECDSA signatures from standard wallets (MetaMask, hardware wallets, anvil) are deterministic
// (RFC 6979), so signing the same message again later reproduces the same salt, and the choice is
// found by trying each candidate against the on-chain commitment. Nothing is stored anywhere.
import { keccak256, zeroHash, type Address, type Hex } from "viem";
import { commitmentHash } from "../chain/reads";

export function recoveryMessage(chainId: number, contract: Address, electionId: bigint): string {
  return [
    "Ostrakon secret ballot",
    `chain: ${chainId}`,
    `contract: ${contract.toLowerCase()}`,
    `election: ${electionId.toString()}`,
    "",
    "Signing this creates the secret that seals your vote, and lets you recover your receipt later.",
    "It costs nothing and sends nothing. Only sign it on the Ostrakon app: anyone who has this",
    "signature can work out your choice before you reveal it.",
  ].join("\n");
}

export function saltFromSignature(signature: Hex): Hex {
  return keccak256(signature);
}

/** The candidate index whose commitment matches the on-chain one, or null. */
export function findChoice(
  chainId: number,
  contract: Address,
  electionId: bigint,
  voter: Address,
  salt: Hex,
  candidateCount: number,
  onChain: Hex,
): number | null {
  if (onChain === zeroHash) return null;
  for (let i = 0; i < candidateCount; i++) {
    if (commitmentHash(chainId, contract, electionId, voter, BigInt(i), salt) === onChain) return i;
  }
  return null;
}
