import { describe, expect, it } from "vitest";
import { renderTeamChatEngagementPrompt, truncate } from "./team-chat-judge.prompt.js";

const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe("team-chat-judge prompt", () => {
  it("backs off before a split surrogate pair when truncating", () => {
    const shortened = truncate(`${"a".repeat(1_998)}😀${"b".repeat(10)}`, 2_000);
    expect(shortened).toBe(`${"a".repeat(1_998)}…`);
    expect(shortened).not.toMatch(loneSurrogate);
    expect(shortened.length).toBeLessThanOrEqual(2_000);
  });

  it("keeps an emoji intact when it fits before the ellipsis", () => {
    const shortened = truncate(`${"a".repeat(1_997)}😀${"b".repeat(10)}`, 2_000);
    expect(shortened).toBe(`${"a".repeat(1_997)}😀…`);
    expect(shortened).not.toMatch(loneSurrogate);
    expect(shortened.length).toBe(2_000);
  });

  it("keeps rendered messages and standing rules well-formed at their length limits", () => {
    const prompt = renderTeamChatEngagementPrompt({
      botName: "Arthur",
      channelId: "C1",
      channelName: "launch",
      rules: `${"r".repeat(3_998)}😀${"x".repeat(10)}`,
      messages: [
        {
          eventId: "Ev-1",
          senderId: "U1",
          senderName: "Ada",
          content: `${"a".repeat(1_998)}😀${"b".repeat(10)}`,
        },
      ],
    });
    expect(prompt).not.toMatch(loneSurrogate);
    expect(prompt).toContain(`${"r".repeat(3_998)}…`);
    expect(prompt).toContain(`${"a".repeat(1_998)}…`);
  });
});
