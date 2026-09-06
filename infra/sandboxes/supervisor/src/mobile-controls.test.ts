import { describe, expect, it } from "vitest";
import { textEdits, textKeysyms } from "../../computer/mobile-controls.js";

describe("mobile desktop keyboard", () => {
  it("handles typing, deletion and phone text replacement", () => {
    expect(textEdits("___", "___hi")).toEqual({ backspaces: 0, text: "hi" });
    expect(textEdits("___hi", "___h")).toEqual({ backspaces: 1, text: "" });
    expect(textEdits("___teh", "___the")).toEqual({ backspaces: 2, text: "he" });
  });
  it("keeps supplementary Unicode characters intact", () => {
    expect(textEdits("_😀", "_😎")).toEqual({ backspaces: 1, text: "😎" });
    expect(textKeysyms("A中😀\n\t")).toEqual([0x41, 0x01004e2d, 0x0101f600, 0xff0d, 0xff09]);
  });
});
