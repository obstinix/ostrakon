import { getAddress, isAddress, zeroAddress, type Address } from "viem";

export interface VoterPreview {
  /** Valid, checksummed, not yet registered, first occurrence. These get sent. */
  add: Address[];
  already: Address[];
  duplicates: Address[];
  zero: number;
  /** Lines that aren't addresses, or have a wrong mixed-case checksum. */
  invalid: { line: string; reason: "format" | "checksum" }[];
}

/**
 * Parse a pasted voter list (newline, comma, space or semicolon separated) and classify each entry
 * before anything is sent. Mixed-case input must pass the EIP-55 checksum; all-lower or all-upper
 * input is accepted and checksummed.
 */
export function previewVoters(raw: string, registered: ReadonlySet<string>): VoterPreview {
  const out: VoterPreview = { add: [], already: [], duplicates: [], zero: 0, invalid: [] };
  const seen = new Set<string>();
  for (const token of raw.split(/[\s,;]+/).filter(Boolean)) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(token)) {
      out.invalid.push({ line: token.slice(0, 64), reason: "format" });
      continue;
    }
    const body = token.slice(2);
    const mixed = body !== body.toLowerCase() && body !== body.toUpperCase();
    if (mixed && !isAddress(token, { strict: true })) {
      out.invalid.push({ line: token, reason: "checksum" });
      continue;
    }
    const a = getAddress(token.toLowerCase());
    const key = a.toLowerCase();
    if (a === zeroAddress) {
      out.zero++;
      continue;
    }
    if (seen.has(key)) {
      out.duplicates.push(a);
      continue;
    }
    seen.add(key);
    if (registered.has(key)) out.already.push(a);
    else out.add.push(a);
  }
  return out;
}

export function chunk<T>(xs: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}
