import type { MessageBlock } from "@rakazo/contracts";
import { REPLY_QUOTE_MAX_LENGTH } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  hasVisibleMessagePresentation,
  isCenteredAgentEvent,
  messagePresentationSegments,
  quotableMessageSegments,
  truncateQuoteExcerpt,
} from "./message-presentation";

describe("mobile message presentation", () => {
  it("centers handoffs, inter-agent messages, and channel mirrors", () => {
    const blocks = [
      { kind: "handoff", fromBotId: "a", toBotId: "b", text: "Go" },
      { kind: "bot_message_sent", toBotId: "b", toBotName: "Research", text: "Go" },
      {
        kind: "bot_message_received",
        fromBotId: "b",
        fromBotName: "Research",
        text: "Done",
      },
      {
        kind: "channel_message",
        provider: "sendblue",
        channelId: "ch-1",
        fromAddress: "+15551234567",
        fromLabel: "Alex",
        text: "Hello from the group",
      },
    ] as MessageBlock[];

    for (const block of blocks) expect(isCenteredAgentEvent([block])).toBe(true);
    expect(isCenteredAgentEvent([{ kind: "text", text: "Hello" }])).toBe(false);
  });

  it("hides completed tool activity", () => {
    const blocks = [
      {
        kind: "steps",
        steps: [
          { label: "Read file", count: 1 },
          { label: "Message bot", count: 1 },
        ],
      },
      { kind: "bot_message_sent", toBotId: "b", toBotName: "Research", text: "Go" },
    ] as MessageBlock[];

    expect(messagePresentationSegments(blocks)).toEqual([
      {
        kind: "content",
        blocks: [{ kind: "bot_message_sent", toBotId: "b", toBotName: "Research", text: "Go" }],
      },
    ]);
    expect(
      hasVisibleMessagePresentation([
        { kind: "steps", steps: [{ label: "Message bot", count: 1 }] },
      ]),
    ).toBe(false);
  });

  it("hides marked activity without treating Using narration as a tool", () => {
    const activity = { kind: "progress", text: "Using browser", activity: true } as const;
    const narration = { kind: "progress", text: "Using browser is optional." } as const;

    expect(messagePresentationSegments([activity, narration])).toEqual([
      { kind: "content", blocks: [narration] },
    ]);

    const mixed: Extract<MessageBlock, { kind: "progress" }> = {
      kind: "progress",
      text: "Let me check",
      pendingToolNames: ["browser"],
    };
    expect(messagePresentationSegments([mixed])).toEqual([{ kind: "content", blocks: [mixed] }]);
  });

  it("keeps only response content around tool activity", () => {
    const tool: Extract<MessageBlock, { kind: "steps" }> = {
      kind: "steps",
      steps: [{ label: "Read file", count: 1 }],
    };

    expect(
      messagePresentationSegments([
        { kind: "text", text: "Checking." },
        tool,
        { kind: "text", text: "Done." },
      ]),
    ).toEqual([
      {
        kind: "content",
        blocks: [
          { kind: "text", text: "Checking." },
          { kind: "text", text: "Done." },
        ],
      },
    ]);

    expect(
      messagePresentationSegments([
        { kind: "steps", steps: [{ label: "Message bot", count: 1 }] },
        { kind: "text", text: "Done." },
      ]),
    ).toEqual([{ kind: "content", blocks: [{ kind: "text", text: "Done." }] }]);
  });
});

describe("quotableMessageSegments", () => {
  it("exposes the server's visible text, not the typographer-rendered glyphs", () => {
    // Bubbles render `—`, curly quotes, and `…`; the server validates against
    // the raw visible text, so the sheet must offer the untransformed glyphs.
    const segments = quotableMessageSegments("bot", [
      {
        kind: "text",
        text: 'run `pnpm dev -- --watch` ... say "hi" -- soon...',
      } as MessageBlock,
    ]);
    expect(segments).toEqual(['run pnpm dev -- --watch ... say "hi" -- soon...']);
  });

  it("keeps user text verbatim since replies validate it as plain text", () => {
    const segments = quotableMessageSegments("user", [
      { kind: "text", text: "look at **this** commit" } as MessageBlock,
    ]);
    expect(segments).toEqual(["look at **this** commit"]);
  });

  it("keeps text blocks as separate segments and drops non-text blocks", () => {
    const segments = quotableMessageSegments("bot", [
      { kind: "text", text: "first" } as MessageBlock,
      {
        kind: "image",
        artifactId: "a1",
        mimeType: "image/png",
        name: "x.png",
      } as MessageBlock,
      { kind: "text", text: "   " } as MessageBlock,
      { kind: "text", text: "second" } as MessageBlock,
    ]);
    expect(segments).toEqual(["first", "second"]);
  });
});

describe("truncateQuoteExcerpt", () => {
  it("leaves short excerpts untouched", () => {
    expect(truncateQuoteExcerpt("short")).toBe("short");
  });

  it("caps at the contract limit", () => {
    expect(truncateQuoteExcerpt("x".repeat(REPLY_QUOTE_MAX_LENGTH + 50))).toHaveLength(
      REPLY_QUOTE_MAX_LENGTH,
    );
  });

  it("does not split a surrogate pair at the boundary", () => {
    const excerpt = "x".repeat(REPLY_QUOTE_MAX_LENGTH - 1) + "😀";
    const truncated = truncateQuoteExcerpt(excerpt + "tail");
    expect(truncated).toHaveLength(REPLY_QUOTE_MAX_LENGTH - 1);
    expect(truncated).toBe("x".repeat(REPLY_QUOTE_MAX_LENGTH - 1));
  });
});
