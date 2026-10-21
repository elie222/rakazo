import { describe, expect, it } from "vitest";
import { spokenTextForRequest } from "./speak-request";

describe("spokenTextForRequest", () => {
  it("speaks the lookup that still matches the latest click", () => {
    expect(spokenTextForRequest(2, 2, { hostSpoken: false, text: "Next." })).toBe("Next.");
  });

  it("drops an older lookup that returns after a newer click", () => {
    expect(spokenTextForRequest(1, 2, { hostSpoken: false, text: "First." })).toBeNull();
  });

  it("does not speak again when the host already did", () => {
    expect(spokenTextForRequest(1, 1, { hostSpoken: true, text: "Said." })).toBeNull();
    expect(spokenTextForRequest(1, 1, { hostSpoken: false, text: "" })).toBeNull();
  });
});
