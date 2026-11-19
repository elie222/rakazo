import type { MessageBlock } from "@rakazo/contracts";
import type * as MessageQuote from "@rakazo/core/message-quote";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyLocalChoiceDismissals,
  choiceCardOptions,
  DISMISSED_CHOICE_ANSWER_ID,
  hasQuotableText,
  hasVisibleMessagePresentation,
  isCenteredAgentEvent,
  messageHasInlineControls,
  messagePresentationSegments,
  quotableMessageSegments,
  threadCardWidth,
} from "./message-presentation";

const parsedMarkdown = vi.hoisted(() => vi.fn());
vi.mock("@rakazo/core/message-quote", async (importOriginal) => {
  const actual = await importOriginal<typeof MessageQuote>();
  return {
    ...actual,
    visibleTextFromMarkdown: (markdown: string) => {
      parsedMarkdown(markdown);
      return actual.visibleTextFromMarkdown(markdown);
    },
  };
});
beforeEach(() => parsedMarkdown.mockClear());

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

  it("draws a setup checklist as its own card and hides a retired one", () => {
    const checklist: MessageBlock = {
      kind: "import_setup",
      items: [{ kind: "routine", routineId: "routine-1", name: "morning" }],
    };
    expect(hasVisibleMessagePresentation([checklist])).toBe(true);
    expect(messagePresentationSegments([checklist])).toEqual([]);
    expect(messagePresentationSegments([{ kind: "text", text: "Imported." }, checklist])).toEqual([
      { kind: "content", blocks: [{ kind: "text", text: "Imported." }] },
    ]);
    expect(messageHasInlineControls([checklist])).toBe(true);
    expect(hasVisibleMessagePresentation([{ ...checklist, undone: true }])).toBe(false);
    expect(hasVisibleMessagePresentation([{ kind: "import_setup", items: [] }])).toBe(false);
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

describe("hasQuotableText", () => {
  const text = (value: string) => [{ kind: "text", text: value } as MessageBlock];

  it("agrees with the quote sheet's segments", () => {
    const samples = [
      "Plain words",
      "## Heading\n\n- **bold** item\n1. step",
      "2024 was a year",
      "> quoted line",
      "```ts\nconst a = 1;\n```",
      "    indented code",
      "| a | b |\n|---|---|\n| 1 | 2 |",
      "![](https://example.com/chart.png)",
      "![chart](https://example.com/chart.png)",
      "<!-- hidden -->",
      "<div>\nhidden\n</div>",
      "[ref]:\nhttps://example.com",
      "[](\nhttps://example.com)",
      "1.",
      "1. \n2. ",
      "---",
      "* * *",
      "&nbsp;",
      "`inline` code",
      "   ",
    ];
    for (const sample of samples) {
      for (const role of ["bot", "user"] as const) {
        const expected = quotableMessageSegments(role, text(sample)).length > 0;
        expect([sample, role, hasQuotableText(role, text(sample))]).toEqual([
          sample,
          role,
          expected,
        ]);
      }
    }
    expect(hasQuotableText("bot", [])).toBe(false);
    expect(hasQuotableText("bot", text("x".repeat(100_001)))).toBe(false);
  });

  it("skips the Markdown parse when the words plainly show", () => {
    const blocks = text("**Done**, the report is ready.");
    expect(hasQuotableText("bot", blocks)).toBe(true);
    expect(parsedMarkdown).not.toHaveBeenCalled();
    expect(hasQuotableText("bot", text("![](https://example.com/chart.png)"))).toBe(false);
    expect(parsedMarkdown).toHaveBeenCalledTimes(1);
  });
});

describe("messageHasInlineControls", () => {
  it("leaves a plain message to the row gestures", () => {
    expect(messageHasInlineControls([{ kind: "text", text: "hello" } as MessageBlock])).toBe(false);
  });

  it("keeps the taps of cards that render their own controls", () => {
    expect(
      messageHasInlineControls([
        { kind: "ask", question: "Which one?", actions: [] } as unknown as MessageBlock,
      ]),
    ).toBe(true);
    expect(
      messageHasInlineControls([
        { kind: "mcp_approval", serverId: "s" } as unknown as MessageBlock,
      ]),
    ).toBe(true);
    expect(
      messageHasInlineControls([
        { kind: "app_connect", provider: "github" } as unknown as MessageBlock,
      ]),
    ).toBe(true);
  });
});
