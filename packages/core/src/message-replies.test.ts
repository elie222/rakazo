import { describe, expect, it } from "vitest";
import { replyLineText, replyMetadata } from "./message-replies.js";

describe("shared reply presentation", () => {
  it("keeps selected quotes on one line and uses preview before local fallback", () => {
    expect(replyLineText("First\nSecond", "preview", "fallback")).toBe("First Second");
    expect(replyLineText(undefined, "First\nSecond", "fallback")).toBe("First");
    expect(replyLineText(undefined, undefined, "Local\nSecond")).toBe("Local");
    expect(replyLineText()).toBe("");
  });
  it("preserves omitted metadata and accepts authoritative unavailable previews", () => {
    const previous = {
      replyToMessageId: "parent",
      replyQuote: "",
      replyPreview: { role: "bot" as const, text: "Earlier" },
    };
    expect(replyMetadata({}, previous)).toEqual(previous);
    expect(replyMetadata({ replyPreview: { text: 12 } }, previous)).toEqual(previous);
    expect(replyMetadata({ replyPreview: null }, previous)).toEqual({
      ...previous,
      replyPreview: null,
    });
    expect(
      replyMetadata(
        {
          replyQuote: "new",
          replyToMessageId: "other",
          replyPreview: { role: "user", text: "New" },
        },
        previous,
      ),
    ).toEqual({
      replyQuote: "new",
      replyToMessageId: "other",
      replyPreview: { role: "user", text: "New" },
    });
  });
});
