import { describe, expect, it } from "vitest";
import { pickWallets } from "./hooks";

describe("pickWallets", () => {
  const generic = { id: "g", name: "Injected", generic: true };
  const mm = { id: "mm", name: "MetaMask", generic: false };
  const rabby = { id: "rb", name: "Rabby", generic: false };

  it("prefers EIP-6963 wallets over the generic window.ethereum connector", () => {
    expect(pickWallets([generic, mm, rabby])).toEqual([mm, rabby]);
  });

  it("falls back to the generic connector when nothing announced itself", () => {
    expect(pickWallets([generic])).toEqual([generic]);
    expect(pickWallets([])).toEqual([]);
  });
});
