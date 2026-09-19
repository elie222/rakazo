import { describe, expect, it } from "vitest";
import {
  completionMarksUnread,
  completionMessageSegments,
  completionNotificationBody,
  completionNotificationPreview,
  isExactNoResponse,
  LONG_WORK_PROGRESS_GUIDANCE,
  NO_RESPONSE,
  ROUTINE_SILENT_REPLY_GUIDANCE,
  runAllowsSilentEmpty,
  runPromotesMidTurnNarration,
  runReplyGuidance,
  stripNoResponseReply,
  subagentMarksUnread,
} from "./executor.js";
import { finalBlocksAfterMidTurnProgress } from "./user-progress.js";

describe("completionMessageSegments", () => {
  it("keeps visible tool activity without appending a generic completion claim", () => {
    const steps = [{ kind: "steps" as const, steps: [{ label: "Message bot", count: 1 }] }];
    expect(completionMessageSegments(steps)).toEqual(steps);
  });

  it("keeps the last-resort fallback for a runtime that produced nothing", () => {
    expect(completionMessageSegments([])).toEqual([{ kind: "text", text: "done." }]);
  });

  it("allows a fully empty completion for silent bot-message wakes", () => {
    expect(completionMessageSegments([], { allowSilentEmpty: true })).toEqual([]);
  });

  it("drops narration after a successful group handoff", () => {
    expect(
      completionMessageSegments([{ kind: "text", text: "Research is checking this." }], {
        suppressOutput: true,
      }),
    ).toEqual([]);
  });

  it("uses a contextual fallback for a non-silent peer result", () => {
    expect(
      completionMessageSegments([], { emptyResponseText: "Update from Researcher: 42" }),
    ).toEqual([{ kind: "text", text: "Update from Researcher: 42" }]);
  });

  it("keeps a peer result visible when the runtime emitted only tool activity", () => {
    const steps = [{ kind: "steps" as const, steps: [{ label: "Read file", count: 1 }] }];
    expect(
      completionMessageSegments(steps, { emptyResponseText: "Update from Researcher: 42" }),
    ).toEqual([...steps, { kind: "text", text: "Update from Researcher: 42" }]);
  });

  it("does not append fallback text to a tool-only FYI", () => {
    const steps = [{ kind: "steps" as const, steps: [{ label: "Read file", count: 1 }] }];
    expect(
      completionMessageSegments(steps, {
        allowSilentEmpty: true,
        emptyResponseText: "synthetic text",
      }),
    ).toEqual(steps);
  });

  it("normalizes a blank fallback", () => {
    expect(completionMessageSegments([], { emptyResponseText: "   " })).toEqual([
      { kind: "text", text: "done." },
    ]);
  });
});

describe("completionNotificationBody", () => {
  it("omits a body when only tool or step activity remains", () => {
    const steps = completionMessageSegments([
      { kind: "steps" as const, steps: [{ label: "Message bot", count: 1 }] },
    ]);
    expect(completionNotificationBody("", steps)).toBe("");
  });

  it("uses the empty-run text when that is all the run produced", () => {
    expect(completionNotificationBody("", completionMessageSegments([]))).toBe("done.");
  });
});

describe("completionNotificationPreview", () => {
  it("preserves filenames in completion notifications", () => {
    expect(completionNotificationPreview("Saved **monthly_sales_report.csv**")).toBe(
      "Saved monthly_sales_report.csv",
    );
  });
  it("strips Markdown and truncates the plain text", () => {
    expect(completionNotificationPreview("Created **Projects-CoS** as a **Project**")).toBe(
      "Created Projects-CoS as a Project",
    );
    const preview = completionNotificationPreview(`${"word ".repeat(50)}**end**`);
    expect(preview).toHaveLength(180);
    expect(preview).not.toContain("*");
    expect(preview.startsWith("word word")).toBe(true);
    expect(completionNotificationPreview("**  **")).toBe("");
  });
});

describe("completionMarksUnread", () => {
  it("ignores silent routine activity but keeps routine comments and manual replies unread", () => {
    expect(completionMarksUnread("routine", "")).toBe(false);
    expect(completionMarksUnread("routine", "Daily report ready")).toBe(true);
    expect(completionMarksUnread("user", "")).toBe(true);
  });

  it("keeps empty-run done. fallback unread and notifying", () => {
    const segments = completionMessageSegments([]);
    const text = completionNotificationBody("", segments);
    expect(segments).toEqual([{ kind: "text", text: "done." }]);
    expect(text).toBe("done.");
    expect(completionMarksUnread("routine", text)).toBe(true);
    expect(completionMarksUnread("user", text)).toBe(true);
  });

  it("does not invent done. unread for a routine whose only activity is a completed subagent", () => {
    // Terminal subagent rows are published separately; skipEmptyFallback mirrors that durable
    // activity so completion does not synthesize "done." (which would mark unread + notify).
    const segments = completionMessageSegments([], { skipEmptyFallback: true });
    const text = completionNotificationBody("", segments);
    expect(segments).toEqual([]);
    expect(text).toBe("");
    expect(completionMarksUnread("routine", text)).toBe(false);
    expect(completionMarksUnread("user", text)).toBe(true);
  });

  it("lets a silent routine finish with no chat text, unread, or notify", () => {
    expect(runAllowsSilentEmpty("routine")).toBe(true);
    expect(runAllowsSilentEmpty("user")).toBe(false);
    const segments = completionMessageSegments([], {
      allowSilentEmpty: runAllowsSilentEmpty("routine"),
    });
    const text = completionNotificationBody("", segments);
    expect(segments).toEqual([]);
    expect(text).toBe("");
    expect(completionMarksUnread("routine", text)).toBe(false);
  });

  it("still invents done. for a user-triggered empty run", () => {
    expect(runAllowsSilentEmpty("user")).toBe(false);
    const segments = completionMessageSegments([], {
      allowSilentEmpty: runAllowsSilentEmpty("user"),
    });
    const text = completionNotificationBody("", segments);
    expect(segments).toEqual([{ kind: "text", text: "done." }]);
    expect(completionMarksUnread("user", text)).toBe(true);
  });

  it("drops a tool-only routine final so an empty watch leaves no chat bubble", () => {
    const steps = [{ kind: "steps" as const, steps: [{ label: "List items", count: 1 }] }];
    const segments = completionMessageSegments(steps, {
      allowSilentEmpty: runAllowsSilentEmpty("routine"),
    });
    const blocks = finalBlocksAfterMidTurnProgress(segments, runAllowsSilentEmpty("routine"));
    expect(segments).toEqual(steps);
    expect(blocks).toEqual([]);
    expect(completionMarksUnread("routine", completionNotificationBody("", blocks))).toBe(false);
  });
});

describe("stripNoResponseReply", () => {
  it("leaves an already-empty reply empty", () => {
    expect(stripNoResponseReply("", [])).toEqual({ assembled: "", blocks: [] });
  });

  it("treats an exact sentinel final as empty", () => {
    const stripped = stripNoResponseReply(NO_RESPONSE, [{ kind: "text", text: NO_RESPONSE }]);
    expect(stripped).toEqual({ assembled: "", blocks: [] });
    const text = completionNotificationBody(stripped.assembled, stripped.blocks);
    expect(text).toBe("");
    expect(completionMarksUnread("routine", text)).toBe(false);
  });

  it("treats a trimmed sentinel as empty", () => {
    const padded = `  ${NO_RESPONSE}  `;
    const stripped = stripNoResponseReply(padded, [{ kind: "text", text: padded }]);
    expect(stripped).toEqual({ assembled: "", blocks: [] });
  });

  it("does not strip the sentinel when extra prose is present", () => {
    const text = `${NO_RESPONSE} all clear`;
    const blocks = [{ kind: "text" as const, text }];
    expect(stripNoResponseReply(text, blocks)).toEqual({ assembled: text, blocks });
    expect(completionMarksUnread("routine", text)).toBe(true);
  });

  it("fails closed on case, punctuation, and wrapped variants", () => {
    expect(isExactNoResponse("no_response")).toBe(false);
    expect(isExactNoResponse("NO_RESPONSE.")).toBe(false);
    expect(isExactNoResponse(`\`${NO_RESPONSE}\``)).toBe(false);
    expect(stripNoResponseReply("no_response", [{ kind: "text", text: "no_response" }])).toEqual({
      assembled: "no_response",
      blocks: [{ kind: "text", text: "no_response" }],
    });
  });

  it("does not strip when assembled is the sentinel but a text block has extra prose", () => {
    const blocks = [{ kind: "text" as const, text: `${NO_RESPONSE} all clear` }];
    expect(stripNoResponseReply(NO_RESPONSE, blocks)).toEqual({
      assembled: NO_RESPONSE,
      blocks,
    });
  });

  it("strips a sentinel text block beside tool activity so the hollow final can drop", () => {
    const steps = { kind: "steps" as const, steps: [{ label: "List items", count: 1 }] };
    const stripped = stripNoResponseReply(NO_RESPONSE, [
      steps,
      { kind: "text", text: NO_RESPONSE },
    ]);
    expect(stripped).toEqual({ assembled: "", blocks: [steps] });
    const blocks = finalBlocksAfterMidTurnProgress(
      stripped.blocks,
      runAllowsSilentEmpty("routine"),
    );
    expect(blocks).toEqual([]);
    expect(completionMarksUnread("routine", completionNotificationBody("", blocks))).toBe(false);
  });
});

describe("runReplyGuidance", () => {
  it("does not ask routine runs for message_user progress", () => {
    expect(runPromotesMidTurnNarration("routine")).toBe(false);
    expect(runReplyGuidance("routine")).toBe(ROUTINE_SILENT_REPLY_GUIDANCE);
    expect(runReplyGuidance("routine")).not.toContain("progress updates with message_user");
    expect(runReplyGuidance("routine")).toContain(NO_RESPONSE);
    expect(runReplyGuidance("routine")).toContain(`exactly ${NO_RESPONSE}`);
    expect(runReplyGuidance("routine")).not.toContain("Leave the final reply empty");
  });

  it("keeps progress guidance for user-triggered runs", () => {
    expect(runPromotesMidTurnNarration("user")).toBe(true);
    expect(runReplyGuidance("user")).toBe(LONG_WORK_PROGRESS_GUIDANCE);
    expect(runReplyGuidance("user")).toContain("message_user");
    expect(runReplyGuidance("messaging")).toBe(LONG_WORK_PROGRESS_GUIDANCE);
  });
});

describe("subagentMarksUnread", () => {
  it("ignores completed routine activity but preserves failures and manual activity", () => {
    expect(subagentMarksUnread("routine", "completed")).toBe(false);
    expect(subagentMarksUnread("routine", "failed")).toBe(true);
    expect(subagentMarksUnread("user", "completed")).toBe(true);
  });
});
