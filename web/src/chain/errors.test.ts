import { describe, expect, it, vi } from "vitest";
import {
  BaseError,
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  encodeErrorResult,
  HttpRequestError,
  UserRejectedRequestError,
  WaitForTransactionReceiptTimeoutError,
} from "viem";
import { ostrakonAbi } from "../generated/ostrakonAbi";
import { CONTRACT_ERROR_COPY, decodeError, GENERIC } from "./errors";

vi.spyOn(console, "error").mockImplementation(() => {});

function revert(errorName: string, args: readonly unknown[]) {
  const data = encodeErrorResult({ abi: ostrakonAbi, errorName: errorName as never, args: args as never });
  const inner = new ContractFunctionRevertedError({ abi: ostrakonAbi, data, functionName: "vote" });
  return new ContractFunctionExecutionError(inner, { abi: ostrakonAbi, functionName: "vote", args: [] });
}

const errorNames = ostrakonAbi.filter((x) => x.type === "error").map((x) => x.name);

describe("decodeError", () => {
  it("has curated copy for every custom error in the ABI", () => {
    for (const name of errorNames) expect(CONTRACT_ERROR_COPY).toHaveProperty(name);
  });

  it("maps a revert by name, with typed args", () => {
    const e = revert("WrongPhase", [1n, 1, 3]);
    expect(decodeError(e)).toEqual({
      code: "WrongPhase",
      message: "That needs the Voting phase, but the election is in Ended.",
    });
    expect(decodeError(revert("DuplicateCandidate", [0n, 2n])).message).toBe(
      "Candidates #1 and #3 have the same name.",
    );
  });

  it("never echoes raw text", () => {
    const secret = "0xdeadbeef stack at foo.ts:12";
    for (const e of [new Error(secret), new BaseError(secret), secret, { message: secret }]) {
      const out = decodeError(e);
      expect(out.message).not.toContain("deadbeef");
      expect(out).toEqual(GENERIC);
    }
  });

  it("classifies wallet rejection and network failures", () => {
    expect(decodeError(new UserRejectedRequestError(new Error("x"))).code).toBe("rejected");
    expect(decodeError({ code: 4001, message: "User denied" }).code).toBe("rejected");
    expect(decodeError(new HttpRequestError({ url: "http://127.0.0.1:8545" })).code).toBe("network");
    expect(decodeError(new WaitForTransactionReceiptTimeoutError({ hash: `0x${"ab".repeat(32)}` })).code).toBe(
      "receipt-timeout",
    );
  });

  it("unknown revert names fall back to curated generic revert copy", () => {
    const inner = new ContractFunctionRevertedError({ abi: ostrakonAbi, data: "0x12345678", functionName: "vote" });
    const out = decodeError(new ContractFunctionExecutionError(inner, { abi: ostrakonAbi, functionName: "vote", args: [] }));
    expect(out.code).toBe("revert");
  });
});
