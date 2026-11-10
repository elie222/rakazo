import { describe, expect, it } from "vitest";
import {
  completeComposerMention,
  composerMentionQuery,
  removeComposerMention,
  resolveComposerSendPlan,
} from "./composer-mentions.js";

describe("inline mention completion", () => {
  it.each([
    ["@bo", 3, "@Bot ", 5],
    ["ask @bo", 7, "ask @Bot ", 9],
    ["ask @bo and do this", 7, "ask @Bot and do this", 9],
    ["ask @bo, please", 6, "ask @Bot, please", 8],
    [" \task\n @bo  later\n", 10, " \task\n @Bot  later\n", 12],
    ["@Bot ask @bo later", 12, "@Bot ask @Bot later", 14],
  ] as const)("replaces the active query in %j", (text, caret, expected, nextCaret) => {
    const query = composerMentionQuery(text, caret);
    expect(query).not.toBeNull();
    expect(completeComposerMention(text, query!, { name: "Bot" })).toEqual({
      text: expected,
      caret: nextCaret,
    });
  });

  it.each(["email@bo", "@bo done", "ordinary text"])(
    "ignores nonqueries at the end of %j",
    (text) => {
      expect(composerMentionQuery(text)).toBeNull();
    },
  );

  it("does not complete a selected range", () => {
    expect(composerMentionQuery("ask @bo later", 5, 7)).toBeNull();
  });

  it("removes repeated tokens without touching suffixes or whitespace", () => {
    expect(removeComposerMention("ask @Bot  and @Bot\n@Botany", { name: "Bot" })).toBe(
      "ask   and \n@Botany",
    );
  });
  it("replaces a complete multiword name when the caret is inside either word", () => {
    const names = [{ name: "Bob" }, { name: "Bob Smith" }, { name: "Bob Jones" }];
    for (const caret of [7, 11]) {
      const text = "ask @Bob Smith  later";
      const query = composerMentionQuery(text, caret, caret, names)!;
      expect(query).toMatchObject({ start: 4, end: 14 });
      expect(completeComposerMention(text, query, names[2]!)).toEqual({
        text: "ask @Bob Jones  later",
        caret: 15,
      });
    }
  });

  it("does not retain or remove a shorter name inside a recognized longer mention", () => {
    const short = { kind: "group", id: "group-bob", name: "Bob" } as const;
    const long = { kind: "bot", id: "bot-bob", name: "Bob Smith" } as const;
    const text = "ask @Bob Smith ";
    expect(removeComposerMention(text, short, [short, long])).toBe(text);
    expect(
      resolveComposerSendPlan({ text, mentions: [long], hasAttachments: false }),
    ).toMatchObject({
      trimmed: "ask @Bob Smith",
      rerouteGroupId: null,
      mentionPayload: [{ kind: "bot", id: "bot-bob" }],
    });
  });

  it("removes a separate shorter occurrence without changing the longer name", () => {
    const short = { name: "Bob" },
      long = { name: "Bob Smith" };
    const text = "@Bob and ask @Bob Smith ";
    expect(removeComposerMention(text, short, [short, long])).toBe(" and ask @Bob Smith ");
  });
  it("strips a separate group occurrence without stripping a longer bot name on send", () => {
    const short = { kind: "group", id: "group-bob", name: "Bob" } as const;
    const long = { kind: "bot", id: "bot-bob", name: "Bob Smith" } as const;
    expect(
      resolveComposerSendPlan({
        text: "@Bob and ask @Bob Smith",
        mentions: [short, long],
        hasAttachments: false,
      }),
    ).toMatchObject({
      trimmed: "and ask @Bob Smith",
      rerouteGroupId: "group-bob",
      mentionPayload: [{ kind: "bot", id: "bot-bob" }],
    });
  });
});
