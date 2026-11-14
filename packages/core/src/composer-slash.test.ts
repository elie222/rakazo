import { describe, expect, it } from "vitest";

import {
  composerSlashOptions,
  composerSlashQuery,
  removeComposerSlashQuery,
  serializeComposerPrompt,
  truncateSlashDescription,
} from "./composer-slash.js";

describe("composerSlashOptions", () => {
  const skills = [{ id: "s1", name: "summarize", description: "Write the weekly notes" }];
  const label = (action: { label: string }) => action.label;
  it("matches descriptions and offers actions only at the start of the draft", () => {
    const start = composerSlashOptions({ start: 0, end: 5, query: "week" }, skills, label);
    expect(start.skills).toEqual(skills);
    const mid = composerSlashOptions({ start: 4, end: 9, query: "week" }, skills, label);
    expect(mid).toEqual({ skills: [], actions: [] });
    expect(
      composerSlashOptions({ start: 0, end: 4, query: "sett" }, skills, label).actions,
    ).toHaveLength(3);
    expect(
      composerSlashOptions({ start: 4, end: 8, query: "sett" }, skills, label).actions,
    ).toEqual([]);
    expect(
      composerSlashOptions({ start: 0, end: 4, query: "konf" }, skills, () => "Konfiguration")
        .actions,
    ).toHaveLength(3);
  });
});

describe("removeComposerSlashQuery", () => {
  it.each([
    ["hi /we there", 3, 6, "hi there"],
    ["/we there", 0, 3, "there"],
    ["please /sum, thanks", 7, 11, "please , thanks"],
    ["see /we", 4, 7, "see "],
  ])("removes the query from %j without doubling a space", (text, start, end, expected) => {
    const removed = removeComposerSlashQuery(text, { start, end, query: "" }, []);
    expect(removed).toEqual({ text: expected, bindings: [], caret: start });
  });

  it("keeps a mention after the query bound to its moved text", () => {
    const mention = { kind: "bot" as const, id: "b1", name: "Bob" };
    const removed = removeComposerSlashQuery("hi /we @Bob", { start: 3, end: 6, query: "we" }, [
      { start: 7, end: 11, mention },
    ]);
    expect(removed.text).toBe("hi @Bob");
    expect(removed.bindings).toEqual([{ start: 3, end: 7, mention }]);
  });
});

describe("composerSlashQuery", () => {
  it("reads a / at the start or after whitespace on the caret's line, never inside bound text", () => {
    expect(composerSlashQuery("/Weekly Rev")).toEqual({ start: 0, end: 11, query: "Weekly Rev" });
    expect(composerSlashQuery("please run /week")).toEqual({ start: 11, end: 16, query: "week" });
    expect(composerSlashQuery("a /b\nc /we now", 10)).toEqual({ start: 7, end: 10, query: "we" });
    for (const text of ["see https://x.com/a", "and/or", "/week\nnext line"])
      expect(composerSlashQuery(text)).toBeNull();
    expect(composerSlashQuery("/week", 1, 3)).toBeNull();
    const token = [{ start: 4, end: 18 }];
    expect(composerSlashQuery("run /weekly-review ", 19, 19, token)).toBeNull();
    expect(composerSlashQuery("run /weekly-review and more", 27, 27, token)).toBeNull();
    expect(composerSlashQuery("run /weekly-review /da", 22, 22, token)).toEqual({
      start: 19,
      end: 22,
      query: "da",
    });
  });

  it("treats a / followed by a space as prose, and a bare / mid-message too", () => {
    expect(composerSlashQuery("is it yes / no")).toBeNull();
    expect(composerSlashQuery("salt / pepper / set")).toBeNull();
    expect(composerSlashQuery("hello / ")).toBeNull();
    expect(composerSlashQuery("see /re ")).toBeNull();
    expect(composerSlashQuery("see /re word")).toBeNull();
    expect(composerSlashQuery("/ notes")).toBeNull();
    expect(composerSlashQuery("is it 1 /")).toBeNull();
    // Mid-message a second slash makes it a path, even when a skill name contains one.
    expect(composerSlashQuery("run /tools/build")).toBeNull();
    expect(composerSlashQuery("yes / no", 5)).toBeNull();
    expect(composerSlashQuery("/")).toEqual({ start: 0, end: 1, query: "" });
  });

  it("ends at the caret, and starts at 0 when only whitespace comes before the /", () => {
    expect(composerSlashQuery("please /sum, thanks", 11)).toEqual({
      start: 7,
      end: 11,
      query: "sum",
    });
    expect(composerSlashQuery("/sum，总结一下", 4)).toEqual({ start: 0, end: 4, query: "sum" });
    // A caret inside a word is editing that word, not asking for a command.
    for (const [text, caret] of [
      ["/sum总结一下", 4],
      ["please /sumthe notes", 11],
      ["/summary please", 4],
      ["run /weeky now", 7],
    ] as const)
      expect(composerSlashQuery(text, caret)).toBeNull();
    expect(composerSlashQuery("\n  /sum")).toEqual({ start: 0, end: 7, query: "sum" });
  });
});

describe("serializeComposerPrompt", () => {
  it("returns draft when no skill or mentions", () => {
    expect(serializeComposerPrompt("  hello", null)).toBe("hello");
  });

  it("prefixes skill slash name alone", () => {
    expect(serializeComposerPrompt("", { name: "Daily standup" })).toBe("/Daily standup");
  });

  it("combines a skill and inline mentions in the draft", () => {
    expect(
      serializeComposerPrompt("ask @Research Writer to check blockers", { name: "Daily standup" }),
    ).toBe("/Daily standup\nask @Research Writer to check blockers");
  });

  it("keeps mentions at their original position", () => {
    expect(serializeComposerPrompt("ask @everyone to go", null)).toBe("ask @everyone to go");
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

  it("keeps emoji intact at the default truncation boundary", () => {
    const prefix = "a".repeat(70);
    expect(truncateSlashDescription(`${prefix}😀bc`)).toBe(`${prefix}😀…`);
  });

  it("leaves text at the code point limit unchanged", () => {
    const text = `${"a".repeat(70)}😀b`;
    expect(truncateSlashDescription(text)).toBe(text);
  });

  it("counts emoji as one code point with a custom limit", () => {
    expect(truncateSlashDescription("😀😀😀😀😀", 4)).toBe("😀😀😀…");
  });

  it("normalizes whitespace and trims before the ellipsis", () => {
    expect(truncateSlashDescription("  😀\n  a\t bc  ", 5)).toBe("😀 a…");
  });
});
