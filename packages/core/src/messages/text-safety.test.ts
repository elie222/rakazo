import { describe, expect, it } from "vitest";
import { stripDirectionalControls } from "./text-safety.js";

describe("stripDirectionalControls", () => {
  it("drops bidi overrides, embeddings, isolates and marks", () => {
    expect(stripDirectionalControls("\u202Eevil\u202C")).toBe("evil");
    expect(stripDirectionalControls("a\u202Bb\u202Ac")).toBe("abc");
    expect(stripDirectionalControls("\u2067right\u2069")).toBe("right");
    expect(stripDirectionalControls("\u200Ex\u200F\u061Cy")).toBe("xy");
  });

  it("keeps emoji joiners and the text around them", () => {
    const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}";
    expect(stripDirectionalControls(family)).toBe(family);
    expect(stripDirectionalControls("שלום עולם")).toBe("שלום עולם");
  });
});
