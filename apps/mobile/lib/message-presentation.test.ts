import type { MessageBlock } from "@rakazo/contracts";
import { REPLY_QUOTE_MAX_LENGTH } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  applyLocalChoiceDismissals,
  choiceCardOptions,
  DISMISSED_CHOICE_ANSWER_ID,
  hasVisibleMessagePresentation,
  isCenteredAgentEvent,
  messagePresentationSegments,
  quotableMessageSegments,
  threadCardWidth,
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

  const choice: Extract<MessageBlock, { kind: "choice" }> = {
    kind: "choice",
    question: "What do you want me on first?",
    options: [
      { id: "day", letter: "A", label: "Day-to-day work" },
      { id: "inbox", letter: "B", label: "Inbox & email" },
    ],
  };

  it("keeps the choice card out of the text bubble", () => {
    expect(messagePresentationSegments([choice])).toEqual([]);
    expect(hasVisibleMessagePresentation([choice])).toBe(true);
    expect(messagePresentationSegments([{ kind: "text", text: "Pick one." }, choice])).toEqual([
      { kind: "content", blocks: [{ kind: "text", text: "Pick one." }] },
    ]);
  });

  it("lists every choice option until one is picked, then only that one", () => {
    expect(choiceCardOptions(choice)).toEqual(choice.options);
    expect(choiceCardOptions({ ...choice, answerId: "inbox" })).toEqual([
      { id: "inbox", letter: "B", label: "Inbox & email" },
    ]);
  });

  it("hides a dismissed choice card", () => {
    const dismissed = { ...choice, answerId: DISMISSED_CHOICE_ANSWER_ID };
    expect(choiceCardOptions(dismissed)).toEqual([]);
    expect(hasVisibleMessagePresentation([dismissed])).toBe(false);
  });

  it("hides a locally dismissed choice before the snapshot stores it", () => {
    const dismissed = new Set([choice.question]);
    expect(hasVisibleMessagePresentation(applyLocalChoiceDismissals([choice], dismissed))).toBe(
      false,
    );
    expect(
      hasVisibleMessagePresentation(
        applyLocalChoiceDismissals([{ kind: "text", text: "Still here." }, choice], dismissed),
      ),
    ).toBe(true);
    const blocks = [choice];
    expect(applyLocalChoiceDismissals(blocks, new Set())).toBe(blocks);
  });

  it("sizes thread cards to the bot row, capped on wide screens", () => {
    expect(threadCardWidth(393)).toBe(317);
    expect(threadCardWidth(1024)).toBe(340);
  });

  it("keeps the computer takeover card out of the text bubble", () => {
    const computer: Extract<MessageBlock, { kind: "computer" }> = {
      kind: "computer",
      state: "Needs you",
      text: "Sign in to continue.",
    };

    expect(messagePresentationSegments([computer])).toEqual([]);
    expect(hasVisibleMessagePresentation([computer])).toBe(true);
    expect(messagePresentationSegments([{ kind: "text", text: "Opening." }, computer])).toEqual([
      { kind: "content", blocks: [{ kind: "text", text: "Opening." }] },
    ]);
  });

  it("keeps choice and computer cards out of the text bubble together", () => {
    const computer: Extract<MessageBlock, { kind: "computer" }> = {
      kind: "computer",
      state: "Needs you",
      text: "Sign in to continue.",
    };
    expect(messagePresentationSegments([{ kind: "text", text: "Hi." }, choice, computer])).toEqual([
      { kind: "content", blocks: [{ kind: "text", text: "Hi." }] },
    ]);
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

  it("yields no segments past the server's source bound", () => {
    const segments = quotableMessageSegments("bot", [
      { kind: "text", text: "x".repeat(90_000) } as MessageBlock,
      { kind: "text", text: "y".repeat(90_000) } as MessageBlock,
    ]);
    expect(segments).toEqual([]);
  });

  it("memoizes segments so row chrome does not reparse markdown", () => {
    const blocks = [{ kind: "text", text: "**bold** words" } as MessageBlock];
    expect(quotableMessageSegments("bot", blocks)).toBe(quotableMessageSegments("bot", blocks));
    expect(quotableMessageSegments("user", blocks)).not.toBe(
      quotableMessageSegments("bot", blocks),
    );
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
