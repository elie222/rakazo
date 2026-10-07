import { describe, expect, it } from "vitest";
import { splitInlineCode, visibleInlineCode } from "./inline-code";

describe("inline code", () => {
  it("turns single-backtick spans into code and leaves the rest as text", () => {
    expect(splitInlineCode("Run `hermes setup` next.")).toEqual([
      { kind: "text", value: "Run " },
      { kind: "code", value: "hermes setup" },
      { kind: "text", value: " next." },
    ]);
    expect(visibleInlineCode("Run `hermes setup` next.")).toBe("Run hermes setup next.");
    expect(splitInlineCode("no commands")).toEqual([{ kind: "text", value: "no commands" }]);
    expect(splitInlineCode("a lone ` stays")).toEqual([{ kind: "text", value: "a lone ` stays" }]);
  });
});
