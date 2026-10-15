import { describe, expect, it } from "vitest";
import { chunk, previewVoters } from "./voters";

const A = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const B = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

describe("previewVoters", () => {
  it("classifies valid, duplicate, already-registered, zero and invalid entries", () => {
    const bad = A.slice(0, 41) + (A[41] === "a" ? "A" : "a"); // flip case of last char -> checksum fails
    const raw = [A, A.toLowerCase(), B, "0x" + "0".repeat(40), "hello", bad, "0x123"].join("\n");
    const p = previewVoters(raw, new Set([B.toLowerCase()]));
    expect(p.add).toEqual([A]);
    expect(p.duplicates).toEqual([A]);
    expect(p.already).toEqual([B]);
    expect(p.zero).toBe(1);
    expect(p.invalid.map((x) => x.reason)).toEqual(["format", "checksum", "format"]);
  });

  it("accepts comma/space separated lists and checksums lowercase input", () => {
    const p = previewVoters(`${A.toLowerCase()}, ${B.toUpperCase().replace("0X", "0x")}`, new Set());
    expect(p.add).toEqual([A, B]);
  });
});

describe("chunk", () => {
  it("splits into batches of at most n", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk(Array.from({ length: 401 }, (_, i) => i), 200).map((c) => c.length)).toEqual([200, 200, 1]);
  });
});
