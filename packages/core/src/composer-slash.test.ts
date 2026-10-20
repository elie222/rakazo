import { describe, expect, it } from "vitest";

import { serializeComposerPrompt, truncateSlashDescription } from "./composer-slash.js";

describe("serializeComposerPrompt", () => {
  it("returns draft when no skill or mentions", () => {
    expect(serializeComposerPrompt("  hello", null, [])).toBe("hello");
  });

  it("prefixes skill slash name alone", () => {
    expect(serializeComposerPrompt("", { name: "Daily standup" }, [])).toBe("/Daily standup");
  });

  it("combines skill, mentions, and draft", () => {
    expect(
      serializeComposerPrompt("check blockers", { name: "Daily standup" }, [
        { name: "Research Writer" },
      ]),
    ).toBe("/Daily standup\n@Research Writer check blockers");
  });

  it("prefixes mentions without a skill", () => {
    expect(serializeComposerPrompt("go", null, [{ name: "everyone" }])).toBe("@everyone go");
  });
});

describe("truncateSlashDescription", () => {
  it("leaves short text alone", () => {
    expect(truncateSlashDescription("short")).toBe("short");
  });

  it("truncates long text with an ellipsis", () => {
    const long = "a".repeat(80);
    expect(truncateSlashDescription(long, 20)).toBe(`${"a".repeat(19)}…`);
  });
});
