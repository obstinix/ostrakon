import { describe, expect, it } from "vitest";
import { commitmentHash } from "../chain/reads";
import { checkCreate } from "../routes/Create";
import { parseReceipt, type Receipt } from "./receipts";

const C = "0x5FbDB2315678afecb367f032d93F642f64180aa3" as const;
const A = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as const;
const B = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;
const SALT = `0x${"11".repeat(32)}` as const;

describe("commitmentHash", () => {
  it("is deterministic and binds every input", () => {
    const base = commitmentHash(31337, C, 6n, A, 1n, SALT);
    expect(commitmentHash(31337, C, 6n, A, 1n, SALT)).toBe(base);
    expect(base).toMatch(/^0x[0-9a-f]{64}$/);
    const variants = [
      commitmentHash(1, C, 6n, A, 1n, SALT), // chain
      commitmentHash(31337, A, 6n, A, 1n, SALT), // contract
      commitmentHash(31337, C, 7n, A, 1n, SALT), // election
      commitmentHash(31337, C, 6n, B, 1n, SALT), // voter
      commitmentHash(31337, C, 6n, A, 2n, SALT), // choice
      commitmentHash(31337, C, 6n, A, 1n, `0x${"12".repeat(32)}`), // salt
    ];
    for (const v of variants) expect(v).not.toBe(base);
  });
});

describe("parseReceipt", () => {
  const good: Receipt = {
    v: 1,
    chainId: 31337,
    contract: C,
    electionId: "6",
    voter: A,
    candidateIndex: 1,
    salt: SALT,
    commitment: commitmentHash(31337, C, 6n, A, 1n, SALT),
  };

  it("accepts a well-formed receipt", () => {
    expect(parseReceipt(JSON.stringify(good))).toEqual(good);
  });

  it("rejects malformed input", () => {
    for (const bad of [
      "not json",
      "{}",
      JSON.stringify({ ...good, v: 2 }),
      JSON.stringify({ ...good, salt: "0x1234" }),
      JSON.stringify({ ...good, voter: "0xnope" }),
      JSON.stringify({ ...good, candidateIndex: -1 }),
      JSON.stringify({ ...good, electionId: "six" }),
    ]) {
      expect(parseReceipt(bad)).toBeNull();
    }
  });
});

describe("checkCreate (secret ballot schedule)", () => {
  const now = Date.parse("2026-01-01T00:00:00Z");
  // datetime-local values are local time, like the form produces.
  const later = (h: number) => {
    const d = new Date(now + h * 3_600_000);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  const ok = (secret: boolean, end: string, reveal: string) =>
    checkCreate("Name", "A\nB", "", end, now, secret, reveal).problems;

  it("requires a scheduled voting close for a scheduled reveal close", () => {
    expect(ok(true, "", later(5))).toContain("A scheduled reveal close needs a scheduled voting close too.");
  });

  it("requires reveal to close after voting", () => {
    expect(ok(true, later(5), later(4))).toContain("The reveal must close after voting closes.");
    expect(ok(true, later(5), later(6))).toEqual([]);
  });

  it("ignores the reveal field for open ballots", () => {
    expect(ok(false, "", later(5))).toEqual([]);
  });
});
