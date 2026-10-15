import { describe, expect, it } from "vitest";
import { replacementOutcome } from "./tx";

describe("replacementOutcome", () => {
  it("only a repriced replacement counts as the user's action", () => {
    expect(replacementOutcome("repriced")).toBe("same-action");
    expect(replacementOutcome("cancelled")).toBe("did-not-happen");
    expect(replacementOutcome("replaced")).toBe("did-not-happen");
  });
});
