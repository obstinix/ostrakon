import { describe, expect, it } from "vitest";
import { buildAllowlist, loadAllowlist, proofFor, verifyMember } from "./allowlist";

const A = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as const;
const B = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;
const C = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as const;
const OUT = "0x14dC79964da2C08b23698B3D3cc7Ca32193d9955" as const;

describe("allowlist", () => {
  const built = buildAllowlist([A, B, C]);

  it("round-trips through the published JSON and proves members", () => {
    const tree = loadAllowlist(built.json)!;
    expect(tree).not.toBeNull();
    expect(tree.root).toBe(built.root);
    for (const m of [A, B, C]) {
      const p = proofFor(tree, m)!;
      expect(verifyMember(built.root, m, p)).toBe(true);
    }
  });

  it("finds members case-insensitively and rejects outsiders", () => {
    const tree = loadAllowlist(built.json)!;
    expect(proofFor(tree, A.toLowerCase() as `0x${string}`)).not.toBeNull();
    expect(proofFor(tree, OUT)).toBeNull();
    const pA = proofFor(tree, A)!;
    expect(verifyMember(built.root, OUT, pA)).toBe(false);
    expect(verifyMember(built.root, B, pA)).toBe(false);
  });

  it("rejects tampered or foreign files", () => {
    const tampered = JSON.parse(built.json);
    tampered.values[0].value = [OUT];
    expect(loadAllowlist(JSON.stringify(tampered))).toBeNull();
    expect(loadAllowlist(JSON.stringify({ ...JSON.parse(built.json), leafEncoding: ["uint256"] }))).toBeNull();
    expect(loadAllowlist("not json")).toBeNull();
    expect(loadAllowlist("{}")).toBeNull();
  });

  it("refuses to build an empty list", () => {
    expect(() => buildAllowlist([])).toThrow();
  });
});
