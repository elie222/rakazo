import type { AgentRunRequest, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import type { AppendEventInput, Prisma } from "@rakazo/db";
import {
  appendEventInTransaction,
  createThreadMessageInTransaction,
  partialReplyClientNonce,
  RunHistoryWriteError,
} from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { PARTIAL_REPLY_NOTE } from "./automated-messages.js";
import { loadBotMessageContext, returnBotMessageOutcome } from "./bot-messages.js";
import type * as ComputerLifecycleModule from "./computer-lifecycle.js";
import { createRunExecutor } from "./executor.js";
import { createJobReconciler } from "./job-reconciler.js";
import { PEER_NOTHING_NEW_REPLY } from "./silent-reply.js";
import { userProgressClientNonce } from "./user-progress.js";

vi.mock("./computer-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ComputerLifecycleModule>()),
  acquireComputerExecutionLease: async () => null,
  provisionComputer: async () => ({ id: "computer-1", kind: "desktop" }),
}));

vi.mock("./bot-messages.js", () => ({
  loadBotMessageContext: vi.fn(async () => ({
    fromBotId: "caller",
    fromBotName: "Caller",
    text: "FYI",
    intent: "fyi",
    hop: 1,
    repliesToRequest: false,
  })),
  returnBotMessageOutcome: vi.fn(async () => undefined),
}));

async function runTurn(
  finalText: string,
  silent = true,
  narration: string | string[] = "I will check that.",
  secrets: string[] = [],
  intent: "fyi" | "request" | "question" = "fyi",
  options: {
    trigger?: string;
    doneText?: string;
    splitText?: boolean;
    priorProgressText?: string;
    runtimeEvents?: AgentRuntimeEvent[];
    runtimeFailure?: boolean;
    runtimeError?: Error;
    runtimeCancel?: boolean;
    failHelperId?: string;
    failMessageOnce?: boolean;
    history?: Array<{ id: string; seq: number; role: string; text: string; clientNonce?: string }>;
    /** When the run started; defaults to now, a turn too fresh for interim messages. */
    startedAt?: Date;
    /** Runs each scripted tool call through the executor, as a real runtime does. */
    executeTools?: boolean;
    /** A hand-written runtime, for orderings a flat event list can't express. */
    runtime?: (request: AgentRunRequest) => AsyncGenerator<AgentRuntimeEvent>;
    /** Lets a test hold an event write open, to land runtime events while it waits. */
    appendGate?: (event: AppendEventInput) => Promise<void> | undefined;
  } = {},
) {
  vi.mocked(loadBotMessageContext).mockResolvedValue({
    kind: "bot_message_received",
    fromBotId: "caller",
    fromBotName: "Caller",
    text: "Look again",
    intent,
    hop: 1,
    repliesToRequest: false,
  });
  const run = {
    id: "run-1",
    botId: "bot-1",
    threadId: "thread-1",
    taskId: "task-1",
    spaceId: "space-1",
    userId: "user-1",
    status: "queued",
    trigger: options.trigger ?? (silent ? "bot_message" : "user"),
    sourceMessageId: "source-1",
    leaseFence: 0,
    ...(options.startedAt ? { startedAt: options.startedAt } : {}),
  };
  const runtimeRun = vi.fn(async function* (request: AgentRunRequest) {
    if (options.runtime) {
      yield* options.runtime(request);
      return;
    }
    if (options.runtimeEvents) {
      for (const event of options.runtimeEvents) {
        yield event;
        if (options.executeTools && event.type === "tool") {
          await request.executeTool?.(event.name, event.args, event.executionId);
        }
      }
      if (options.runtimeCancel) {
        run.status = "cancelled";
        yield { type: "done" as const };
      }
      if (options.runtimeFailure) {
        throw options.runtimeError ?? new Error("fixture runtime failure");
      }
      return;
    }
    const narrations = Array.isArray(narration) ? narration : [narration];
    for (const [index, text] of narrations.entries()) {
      for (const chunk of options.splitText ? [...text] : [text]) {
        yield { type: "text" as const, text: chunk };
      }
      yield {
        type: "tool" as const,
        name: "read_file",
        args: {},
        executionId: `call-${index + 1}`,
      };
    }
    if (finalText) yield { type: "text" as const, text: finalText };
    yield { type: "done" as const, text: options.doneText ?? narrations.join("") + finalText };
  });
  const messages: { blocks: MessageBlock[] }[] = [];
  const savedEvents: AppendEventInput[] = [];
  let failMessage = options.failMessageOnce;
  const prisma = {
    user: { findUnique: vi.fn(async () => null) },
    run: {
      findUnique: vi.fn(async () => run),
      findUniqueOrThrow: vi.fn(async () => run),
      updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(run, data);
        return { count: 1 };
      }),
    },
    chatGroup: { findMany: vi.fn(async () => []) },
    bot: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: run.botId,
        name: "Assistant",
        title: "Assistant",
        description: "Test assistant",
        modelProvider: null,
        modelId: null,
        thinkingLevel: null,
        computerId: "computer-1",
        computerSwitching: false,
        memoryScope: null,
        computer: { id: "computer-1", scope: "dedicated" },
      })),
      findMany: vi.fn(async () => []),
    },
    attempt: {
      create: vi.fn(async () => ({ id: "attempt-1" })),
      update: vi.fn(),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    thread: {
      update: vi.fn(async () => ({
        nextMessageSeq: messages.length + 1,
        nextEventSeq: savedEvents.length + 1,
      })),
      findUniqueOrThrow: vi.fn(async () => ({
        id: run.threadId,
        groupId: null,
        historyCompactionSummary: null,
        historyCompactedUpToSeq: null,
        nextMessageSeq: 3,
      })),
    },
    event: {
      create: vi.fn(async ({ data }: { data: AppendEventInput }) => {
        if (
          data.type === "thread.subagent" &&
          (data.payload as { status?: string; agentId?: string }).status === "failed" &&
          (data.payload as { agentId?: string }).agentId === options.failHelperId
        )
          throw new Error("fixture settlement unavailable");
        savedEvents.push(data);
        return { ...data, seq: savedEvents.length };
      }),
    },
    message: {
      create: vi.fn(async ({ data }: { data: { blocks: MessageBlock[] } }) => {
        if (failMessage) {
          failMessage = false;
          throw new Error("fixture message unavailable");
        }
        messages.push(data);
        return { ...data, id: `message-${messages.length}` };
      }),
      findMany: vi.fn(async ({ where }: { where: { runId?: string } }) =>
        !where.runId && options.history
          ? options.history.toReversed().map((message) => ({
              ...message,
              threadId: run.threadId,
              botId: message.role === "bot" ? run.botId : null,
              runId: null,
              blocks: [{ kind: "text", text: message.text }],
              createdAt: new Date("2026-10-24T08:00:00.000Z"),
              replyToMessageId: null,
              replyQuote: null,
              replyTo: null,
              clientNonce: message.clientNonce ?? null,
            }))
          : where.runId === run.id && options.priorProgressText
            ? [
                {
                  blocks: [{ kind: "text", text: options.priorProgressText }],
                  clientNonce: userProgressClientNonce(run.id),
                },
              ]
            : [],
      ),
      findUnique: vi.fn(async () =>
        run.trigger === "messaging"
          ? { blocks: [{ kind: "channel_message", channelId: "channel-1" }] }
          : null,
      ),
      findFirst: vi.fn(async () => null),
    },
    task: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: run.taskId,
        prompt: "Look again",
      })),
    },
    computer: { updateMany: vi.fn(async () => ({ count: 1 })) },
    connection: { findMany: vi.fn(async () => []) },
    userModelPreference: {
      findFirst: vi.fn<(...args: unknown[]) => Promise<Record<string, unknown> | null>>(
        async () => null,
      ),
    },
    secret: { findMany: vi.fn(async () => []), findFirst: vi.fn(async () => null) },
    userModelCredential: { findFirst: vi.fn(async () => null) },
    spaceSettingOverride: { findUnique: vi.fn(async () => null) },
    userModelRoleChoice: { findMany: vi.fn(async () => []) },
    deploymentSettings: {
      findUnique: vi.fn(async () => ({
        defaultModelProvider: "openrouter",
        defaultModelId: "fixture-model",
      })),
    },
    taughtSkill: { findMany: vi.fn(async () => []) },
    vaultCredential: { findMany: vi.fn(async () => []) },
    agentSkill: { findMany: vi.fn(async () => []) },
    scratchpadItem: { findMany: vi.fn(async () => []) },
    externalEffect: {
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => null),
      findUnique: vi.fn(async () => null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: `effect-${data.idempotencyKey}`,
        ...data,
      })),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    userActionApprovalRule: { findMany: vi.fn(async () => []) },
    userActionAutoReviewPreference: { findUnique: vi.fn(async () => null) },
    computerExecutionLease: {
      updateManyAndReturn: vi.fn(async () => [{ fence: 1 }]),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    $queryRaw: vi.fn(async () => [{ id: "row-1", scope: "dedicated" }]),
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>): Promise<unknown> => {
      const messageCount = messages.length;
      const eventCount = savedEvents.length;
      try {
        return await fn(prisma);
      } catch (error) {
        messages.length = messageCount;
        savedEvents.length = eventCount;
        throw error;
      }
    }),
  };
  const finalizeRun = vi.fn(async (_input: { blocks: MessageBlock[] }) => ({
    continuationRunId: null,
  }));
  const append = vi.fn(async (event: AppendEventInput) => {
    await options.appendGate?.(event);
    return appendEventInTransaction(prisma as unknown as Prisma.TransactionClient, event);
  });
  const pauseRunForInput = vi.fn(async () => ({ continuationRunId: null }));
  const executor = createRunExecutor({
    deploymentModelKey: "fixture-model-key",
    prisma,
    runtime: {
      describe: () => ({ capabilities: { scripted: false } }),
      run: runtimeRun,
    },
    sandbox: {
      describe: () => ({ capabilities: { graphical: false } }),
      writeFile: vi.fn(async () => undefined),
      async *exportWorkspace() {
        yield* [];
      },
    },
    home: { commit: vi.fn(async () => "fixture-revision") },
    memory: { read: async () => ({ documents: [] }) },
    memoryProviders: { resolve: async () => null },
    events: { append, finalizeRun, pauseRunForInput, notify: vi.fn(async () => undefined) },
    jobs: { enqueue: vi.fn(async () => undefined) },
    secrets,
  } as unknown as Parameters<typeof createRunExecutor>[0]);

  await executor.continueRun(run.id, "worker-1");
  expect(runtimeRun).toHaveBeenCalled();
  if (!options.runtimeFailure)
    expect(finalizeRun).not.toHaveBeenCalledWith(expect.objectContaining({ outcome: "failed" }));
  return { finalizeRun, append, pauseRunForInput, messages, savedEvents, prisma, runtimeRun };
}

/** Notes saved on the final reply's steps, in order. */
function stepNotes(finalizeRun: Awaited<ReturnType<typeof runTurn>>["finalizeRun"]) {
  return finalizeRun.mock.calls[0]![0].blocks.flatMap((block) =>
    block.kind === "steps" ? block.steps.flatMap((step) => (step.note ? [step.note] : [])) : [],
  );
}

describe.each(["routine", "reaction", "bot_message", "messaging"])(
  "held-back narration on %s runs",
  (trigger) => {
    it("restores the last non-empty narration as a normal final reply", async () => {
      vi.mocked(returnBotMessageOutcome).mockClear();
      const { finalizeRun, append } = await runTurn(
        "",
        true,
        ["I will check that.", "  The draft is posted.  ", "   "],
        [],
        "fyi",
        { trigger },
      );
      expect(finalizeRun).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          outcome: "completed",
          markUnread: trigger !== "bot_message",
        }),
      );
      expect(finalizeRun.mock.calls[0]![0].blocks.filter((block) => block.kind === "text")).toEqual(
        [{ kind: "text", text: "The draft is posted." }],
      );
      expect(append.mock.calls.map(([event]) => event.type)).not.toContain(
        "thread.message.created",
      );
      if (trigger === "bot_message") {
        expect(returnBotMessageOutcome).toHaveBeenCalledExactlyOnceWith(
          expect.anything(),
          expect.anything(),
          expect.anything(),
          "The draft is posted.",
          "result",
        );
      }
    });

    it("keeps a non-empty post-tool final", async () => {
      const { finalizeRun } = await runTurn("Checked: all clear.", true, undefined, [], "fyi", {
        trigger,
      });
      expect(finalizeRun.mock.calls[0]![0].blocks.filter((block) => block.kind === "text")).toEqual(
        [{ kind: "text", text: "Checked: all clear." }],
      );
    });

    it.each([
      { narration: ["I will check that.", "NO_RESPONSE"], doneText: "" },
      { narration: ["NO_RESPONSE", "The draft is posted."], doneText: "" },
      { narration: ["I will check that. NO_RESPONSE"], doneText: "" },
      { narration: ["NO_RESPONSENO_RESPONSE"], doneText: "" },
      { narration: ["The draft is posted."], doneText: "NO_RESPONSE" },
    ])("respects explicit silence in any turn: %j", async ({ narration, doneText }) => {
      vi.mocked(returnBotMessageOutcome).mockClear();
      const { finalizeRun } = await runTurn("", true, narration, [], "fyi", {
        trigger,
        doneText,
        splitText: true,
      });
      expect(finalizeRun.mock.calls[0]![0].blocks.filter((block) => block.kind === "text")).toEqual(
        [],
      );
      expect(returnBotMessageOutcome).not.toHaveBeenCalled();
    });

    it("respects an explicit silent final", async () => {
      const { finalizeRun } = await runTurn("NO_RESPONSE", true, undefined, [], "fyi", { trigger });
      expect(finalizeRun.mock.calls[0]![0].blocks.filter((block) => block.kind === "text")).toEqual(
        [],
      );
    });

    it("does not confuse an identifier with the silence token across chunks", async () => {
      const { finalizeRun } = await runTurn(
        "",
        true,
        "NO_RESPONSE_POLICY is configured.",
        [],
        "fyi",
        {
          trigger,
          splitText: true,
        },
      );
      expect(finalizeRun.mock.calls[0]![0].blocks.filter((block) => block.kind === "text")).toEqual(
        [{ kind: "text", text: "NO_RESPONSE_POLICY is configured." }],
      );
    });
  },
);

it("redacts restored narration", async () => {
  const { finalizeRun } = await runTurn(
    "",
    true,
    "The fake-secret-value is configured.",
    ["fake-secret-value"],
    "fyi",
    { trigger: "routine" },
  );
  expect(finalizeRun.mock.calls[0]![0].blocks.filter((block) => block.kind === "text")).toEqual([
    { kind: "text", text: "The [redacted] is configured." },
  ]);
});

it("does not restore narration already published as durable progress", async () => {
  const { finalizeRun } = await runTurn("", true, "The draft is posted.", [], "fyi", {
    trigger: "reaction",
    priorProgressText: "The draft is posted.",
  });
  expect(finalizeRun.mock.calls[0]![0].blocks.filter((block) => block.kind === "text")).toEqual([]);
});

it("keeps background ticket runs silent", async () => {
  const { finalizeRun } = await runTurn("", true, undefined, [], "fyi", { trigger: "tickets" });
  expect(finalizeRun.mock.calls[0]![0].blocks).toEqual([]);
});

describe("held-back narration on peer requests", () => {
  it.each(["request", "question"] as const)(
    "saves the last non-empty narration as the final result for an empty %s reply",
    async (intent) => {
      vi.mocked(returnBotMessageOutcome).mockClear();
      const { finalizeRun, append } = await runTurn(
        "",
        true,
        ["I will check that.", "  The draft is posted.  ", "   "],
        [],
        intent,
      );
      expect(finalizeRun).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ outcome: "completed" }),
      );
      expect(finalizeRun.mock.calls[0]![0].blocks.filter((block) => block.kind === "text")).toEqual(
        [{ kind: "text", text: "The draft is posted." }],
      );
      expect(append.mock.calls.map(([event]) => event.type)).not.toContain(
        "thread.message.created",
      );
      expect(returnBotMessageOutcome).toHaveBeenCalledExactlyOnceWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        "The draft is posted.",
        "result",
      );

      // A worker stopping after finalizeRun leaves only these saved blocks for retry.
      vi.mocked(returnBotMessageOutcome).mockClear();
      const terminalRun = {
        id: "run-1",
        status: "completed",
        botId: "bot-1",
        bot: { name: "Assistant" },
      };
      const reconciler = createJobReconciler({
        prisma: {
          run: {
            findMany: vi.fn(async ({ where }: { where: { trigger?: string } }) =>
              where.trigger === "bot_message" ? [terminalRun] : [],
            ),
            updateMany: vi.fn(async () => ({ count: 1 })),
          },
          routine: { findMany: vi.fn(async () => []) },
          computer: { findMany: vi.fn(async () => []) },
          messagingOutbound: { findFirst: vi.fn(async () => null) },
          message: {
            findMany: vi.fn(async () => [
              { blocks: finalizeRun.mock.calls[0]![0].blocks, clientNonce: null },
            ]),
          },
        },
        jobs: { enqueue: vi.fn() },
        events: {},
      } as unknown as Parameters<typeof createJobReconciler>[0]);
      await reconciler.reconcileOnce();
      expect(returnBotMessageOutcome).toHaveBeenCalledExactlyOnceWith(
        expect.anything(),
        terminalRun,
        { id: "bot-1", name: "Assistant" },
        "The draft is posted.",
        "result",
        { forceUnread: false },
      );
    },
  );
});

describe("withheld narration on short reply-producing turns", () => {
  // A short pre-tool note now becomes the working line, so it stays in the reply only when
  // no final text follows (it used to be kept before a final as well).
  it.each(["", "Checked: all clear."])("keeps pre-tool text with final %j", async (finalText) => {
    const { finalizeRun } = await runTurn(finalText, false);
    const text = finalizeRun.mock.calls[0]![0].blocks.filter((block) => block.kind === "text")
      .map((block) => block.text)
      .join("");
    expect(text).toBe(finalText || "I will check that.");
  });
});

describe("text from separate assistant turns", () => {
  // The note now leaves the live text for the working line, so what streams after it is the
  // final text alone; the redactor's held-back copy of the note is not streamed again.
  it("streams the break when the redactor holds all pre-tool text", async () => {
    const narration = "I will check that.";
    const finalText = "Checked: all clear.";
    const { append } = await runTurn(finalText, false, narration, [
      "fake-secret-longer-than-the-entire-reply-for-redactor-buffering",
    ]);
    const payloads = append.mock.calls
      .map(([event]) => event)
      .filter((event) => event.type === "thread.progress")
      .map((event) => event.payload as { text?: string; delta?: string; reset?: boolean });
    const reset = payloads.findIndex((payload) => payload.reset);
    expect(payloads[reset]).toMatchObject({ text: narration });
    const after = payloads
      .slice(reset + 1)
      .map((payload) => payload.text ?? payload.delta ?? "")
      .join("");
    expect(after).toBe(finalText);
  });
});

describe("notes that can't be posted as messages", () => {
  const finalText = (finalizeRun: Awaited<ReturnType<typeof runTurn>>["finalizeRun"]) =>
    finalizeRun.mock.calls[0]![0].blocks.filter((block) => block.kind === "text")
      .map((block) => block.text)
      .join("");
  const progress = (append: Awaited<ReturnType<typeof runTurn>>["append"]) =>
    append.mock.calls
      .map(([event]) => event)
      .filter((event) => event.type === "thread.progress" || event.type === "agent.tool.called");
  const sentTexts = (messages: Awaited<ReturnType<typeof runTurn>>["messages"]) =>
    messages.map((message) =>
      message.blocks.map((block) => ("text" in block ? block.text : "")).join(""),
    );

  it("leaves a fresh turn's note out of the reply and shows it as the working line", async () => {
    const { finalizeRun, append } = await runTurn("Checked: all clear.", false);
    expect(finalText(finalizeRun)).toBe("Checked: all clear.");
    const events = progress(append);
    const tool = events.findIndex((event) => event.type === "agent.tool.called");
    // The streamed note is replaced by the working line once the step starts.
    expect(events[tool + 1]).toMatchObject({
      type: "thread.progress",
      payload: { reset: true, text: "I will check that.", activity: true },
    });
  });

  it("keeps the last note as the reply when nothing comes after the last step", async () => {
    const { finalizeRun } = await runTurn("", false);
    expect(finalText(finalizeRun)).toBe("I will check that.");
  });

  it("posts three notes on a long turn and shows the rest only as the working line", async () => {
    const notes = ["One.", "Two.", "Three.", "Four.", "Five.", "Six."];
    const { finalizeRun, append, messages } = await runTurn("All done.", false, notes, [], "fyi", {
      startedAt: new Date(Date.now() - 120_000),
    });
    expect(sentTexts(messages)).toEqual(["One.", "Two.", "Three."]);
    expect(finalText(finalizeRun)).toBe("All done.");
    const statuses = progress(append)
      .filter((event) => (event.payload as { reset?: boolean }).reset)
      .map((event) => (event.payload as { text: string }).text);
    expect(statuses).toEqual(["Four.", "Five.", "Six."]);
  });

  it.each([
    "Checking the totals.",
    `Opening the supplier portal ${"and checking every invoice ".repeat(4)}now.`,
    "The report is at https://example.com/reports/7",
    "Run `npm test` before merging.",
    "Totals:\n- March: 4\n- April: 7",
    "The total is $42.",
  ])("keeps text written before a step out of the reply, on that step: %j", async (narration) => {
    const { finalizeRun, append } = await runTurn("Done.", false, narration);
    expect(finalText(finalizeRun)).toBe("Done.");
    expect(stepNotes(finalizeRun)).toEqual([narration]);
    expect(progress(append).some((event) => (event.payload as { reset?: boolean }).reset)).toBe(
      true,
    );
  });

  it("keeps an answer written before the last step and replies with what follows it", async () => {
    const { finalizeRun } = await runTurn("", false, undefined, [], "fyi", {
      runtimeEvents: [
        { type: "text", text: "The meeting is with Anna." },
        { type: "tool", name: "save_event", args: {}, executionId: "call-1" },
        { type: "text", text: "Saved." },
        { type: "done", text: "" },
      ],
    });
    expect(finalText(finalizeRun)).toBe("Saved.");
    expect(finalizeRun.mock.calls[0]![0].blocks).toContainEqual({
      kind: "steps",
      steps: [{ label: "Save event", count: 1, note: "The meeting is with Anna." }],
    });
  });

  it("brings every working-line note back, in order, when nothing follows the last step", async () => {
    const { finalizeRun } = await runTurn("", false, ["Paragraph A.", "Paragraph B."]);
    expect(finalText(finalizeRun)).toBe("Paragraph A.\n\nParagraph B.");
    expect(stepNotes(finalizeRun)).toEqual([]);
  });

  it("keeps a long answer written before a closing step whole", async () => {
    const answer = `Here is the summary. ${"Every supplier was checked against the order. ".repeat(15)}`;
    const { finalizeRun } = await runTurn("", false, answer);
    expect(answer.length).toBeGreaterThan(500);
    expect(finalText(finalizeRun).trim()).toBe(answer.trim());
  });

  it("never cuts long text into a message, even once messages may be posted", async () => {
    const long =
      `Here is what I found so far. ${"Each supplier matched the order totals. ".repeat(15)}`.trim();
    const { finalizeRun, messages } = await runTurn(
      "Done.",
      false,
      [long, "Saving the file."],
      [],
      "fyi",
      {
        startedAt: new Date(Date.now() - 120_000),
      },
    );
    expect(long.length).toBeGreaterThan(500);
    // The long text stays whole on its step; the short one after it is posted on its own.
    expect(sentTexts(messages)).toEqual(["Saving the file."]);
    expect(stepNotes(finalizeRun)).toEqual([long]);
    expect(finalText(finalizeRun)).toBe("Done.");
  });

  it("redacts notes like the reply", async () => {
    const { finalizeRun, append } = await runTurn("Done.", false, "The fake-secret-value is set.", [
      "fake-secret-value",
    ]);
    expect(stepNotes(finalizeRun)).toEqual(["The [redacted] is set."]);
    expect(JSON.stringify(append.mock.calls)).not.toContain("fake-secret-value");
  });

  it.each([
    ["once messages may be posted", new Date(Date.now() - 120_000)],
    ["on a fresh turn", undefined],
  ])("hides the rest of a secret split across two steps, %s", async (_, startedAt) => {
    const { finalizeRun, append, messages } = await runTurn(
      "Done.",
      false,
      ["The token is hunter", " abcxyz saved."],
      ["hunter abcxyz"],
      "fyi",
      { startedAt },
    );
    const shown = JSON.stringify([append.mock.calls, messages, stepNotes(finalizeRun)]);
    expect(shown).not.toContain("abcxyz");
    expect(shown).toContain("[redacted] saved.");
  });

  it("keeps tool status lines from replacing the note until the bot writes again", async () => {
    const { append } = await runTurn("", false, undefined, [], "fyi", {
      runtimeEvents: [
        { type: "text", text: "Checking the totals." },
        { type: "tool", name: "read_file", args: {}, executionId: "call-1" },
        { type: "progress", text: "Reading totals.csv", activity: true },
        { type: "text", text: "They match." },
        { type: "done", text: "Checking the totals.They match." },
      ],
    });
    const lines = progress(append)
      .filter((event) => event.type === "thread.progress")
      .map((event) => event.payload as { text?: string; activity?: boolean });
    expect(lines.some((line) => line.text === "Reading totals.csv")).toBe(false);
    expect(lines.at(-1)).toMatchObject({ text: "They match." });
  });

  it("shows the next step's status line once a step starts without a note of its own", async () => {
    const { append } = await runTurn("", false, undefined, [], "fyi", {
      runtimeEvents: [
        { type: "text", text: "Checking the totals." },
        { type: "tool", name: "read_file", args: {}, executionId: "call-1" },
        { type: "tool", name: "read_file", args: {}, executionId: "call-2" },
        { type: "progress", text: "Reading march.csv", activity: true },
        { type: "text", text: "They match." },
        { type: "done", text: "Checking the totals.They match." },
      ],
    });
    // The live view drops the note when the next step starts, so that step's status shows.
    const lines = progress(append)
      .filter((event) => event.type === "thread.progress")
      .map((event) => event.payload as { text?: string; activity?: boolean });
    expect(lines).toContainEqual({ text: "Reading march.csv", activity: true });
  });
});

describe("a message from the person while the bot works", () => {
  const sentTexts = (messages: Awaited<ReturnType<typeof runTurn>>["messages"]) =>
    messages.map((message) =>
      message.blocks.map((block) => ("text" in block ? block.text : "")).join(""),
    );
  const finalText = (finalizeRun: Awaited<ReturnType<typeof runTurn>>["finalizeRun"]) =>
    finalizeRun.mock.calls[0]![0].blocks.filter((block) => block.kind === "text")
      .map((block) => block.text)
      .join("");

  it("posts what came before it on its own and lets the next note answer at once", async () => {
    const { finalizeRun, messages } = await runTurn("", false, undefined, [], "fyi", {
      runtimeEvents: [
        { type: "text", text: "Found three suppliers so far." },
        { type: "steered", fromRunUser: true },
        { type: "text", text: "Yes, I'm still on it." },
        { type: "tool", name: "read_file", args: {}, executionId: "call-1" },
        { type: "text", text: "Checking the fourth." },
        { type: "tool", name: "read_file", args: {}, executionId: "call-2" },
        { type: "text", text: "All four checked." },
        { type: "done", text: "" },
      ],
    });
    // The turn is still fresh, yet the answer to the person is a message, then the budget
    // waits again: the next note stays a working line.
    expect(sentTexts(messages)).toEqual(["Found three suppliers so far.", "Yes, I'm still on it."]);
    expect(finalText(finalizeRun)).toBe("All four checked.");
  });

  it("posts a message_user answer to the person at once, even on a fresh turn", async () => {
    const answer = async (steered: boolean) =>
      (
        await runTurn("", false, undefined, [], "fyi", {
          executeTools: true,
          runtimeEvents: [
            ...(steered ? [{ type: "steered" as const, fromRunUser: true }] : []),
            {
              type: "tool",
              name: "message_user",
              args: { message: "Yes, still on it." },
              executionId: "call-1",
            },
            { type: "text", text: "All four checked." },
            { type: "done", text: "" },
          ],
        })
      ).messages;
    expect(sentTexts(await answer(true))).toEqual(["Yes, still on it."]);
    // Without the person's message the turn is too fresh for an interim message.
    expect(sentTexts(await answer(false))).toEqual([]);
  });

  it("keeps a plain answer with no step after it in the reply", async () => {
    const { messages, finalizeRun } = await runTurn("", false, undefined, [], "fyi", {
      runtimeEvents: [
        { type: "steered", fromRunUser: true },
        { type: "text", text: "Yes, still on it." },
        { type: "turn" },
        { type: "text", text: "All four checked." },
        { type: "done", text: "" },
      ],
    });
    expect(sentTexts(messages)).toEqual([]);
    expect(finalText(finalizeRun)).toBe("Yes, still on it.\n\nAll four checked.");
  });

  it("keeps a long answer to the person in the reply, whole", async () => {
    const summary = `Full summary: ${"Supplier totals match the order. ".repeat(60)}`.trim();
    const { messages, finalizeRun } = await runTurn("", false, undefined, [], "fyi", {
      runtimeEvents: [
        { type: "steered", fromRunUser: true },
        { type: "text", text: summary },
        { type: "turn" },
        { type: "text", text: "That's everything." },
        { type: "done", text: "" },
      ],
    });
    expect(summary.length).toBeGreaterThan(1_900);
    expect(sentTexts(messages)).toEqual([]);
    expect(finalText(finalizeRun)).toBe(`${summary}\n\nThat's everything.`);
  });

  it("keeps the immediate answer for message_user when the bot writes something before it", async () => {
    const { messages } = await runTurn("", false, undefined, [], "fyi", {
      executeTools: true,
      runtimeEvents: [
        { type: "steered", fromRunUser: true },
        { type: "text", text: "Let me answer that." },
        {
          type: "tool",
          name: "message_user",
          args: { message: "Yes, still on it." },
          executionId: "call-1",
        },
        { type: "text", text: "All four checked." },
        { type: "done", text: "" },
      ],
    });
    expect(sentTexts(messages)).toEqual(["Yes, still on it."]);
  });

  it("keeps a long answer to the person whole on the step that follows it", async () => {
    const summary = `Full summary: ${"Supplier totals match the order. ".repeat(20)}`.trim();
    const { messages, finalizeRun } = await runTurn("", false, undefined, [], "fyi", {
      runtimeEvents: [
        { type: "steered", fromRunUser: true },
        { type: "text", text: summary },
        { type: "turn" },
        { type: "text", text: "Checking one more file." },
        { type: "tool", name: "read_file", args: {}, executionId: "call-1" },
        { type: "text", text: "Done." },
        { type: "done", text: "" },
      ],
    });
    expect(summary.length).toBeGreaterThan(500);
    expect(sentTexts(messages)).toEqual([]);
    expect(stepNotes(finalizeRun)).toEqual([`${summary}\n\nChecking one more file.`]);
    expect(finalText(finalizeRun)).toBe("Done.");
  });

  it("keeps an allowance granted by a mid-task message that lands during message_user", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let reached!: () => void;
    const statusWriting = new Promise<void>((resolve) => (reached = resolve));
    let holding = true;
    const { messages } = await runTurn("", false, undefined, [], "fyi", {
      // The status line for the text before message_user is held open, so the person's
      // message is handled while message_user is still running.
      appendGate: (event) => {
        if (!holding || !(event.payload as { reset?: boolean } | undefined)?.reset) return;
        reached();
        return gate;
      },
      runtime: async function* (request) {
        yield { type: "text", text: "Let me check." };
        const call = request.executeTool!("message_user", { message: "Working on it." }, "call-1");
        await statusWriting;
        yield { type: "steered", fromRunUser: true };
        holding = false;
        release();
        await call;
        yield { type: "text", text: "Yes, still on it." };
        yield { type: "tool", name: "read_file", args: {}, executionId: "call-2" };
        yield { type: "text", text: "Done." };
        yield { type: "done", text: "" };
      },
    });
    // The allowance the person's message granted mid-call isn't reset when the call ends: the
    // turn is still fresh, yet the message_user update is posted.
    expect(sentTexts(messages)).toEqual(["Working on it."]);
  });

  it("keeps messages from webhooks, external chats and other members on the normal budget", async () => {
    const steps = ["One.", "Two.", "Three.", "Four.", "Five."].flatMap((text, index) => [
      { type: "steered" as const, fromRunUser: false },
      { type: "text" as const, text },
      { type: "tool" as const, name: "read_file", args: {}, executionId: `call-${index}` },
    ]);
    const { messages } = await runTurn("", false, undefined, [], "fyi", {
      startedAt: new Date(Date.now() - 120_000),
      runtimeEvents: [...steps, { type: "text", text: "Done." }, { type: "done", text: "" }],
    });
    expect(sentTexts(messages)).toEqual(["One.", "Two.", "Three."]);
  });

  it("restarts the budget at most once a minute however often the person writes", async () => {
    const { messages } = await runTurn("", false, undefined, [], "fyi", {
      runtimeEvents: [
        { type: "steered", fromRunUser: true },
        { type: "text", text: "Reply one." },
        { type: "tool", name: "read_file", args: {}, executionId: "call-1" },
        { type: "steered", fromRunUser: true },
        { type: "text", text: "Reply two." },
        { type: "tool", name: "read_file", args: {}, executionId: "call-2" },
        { type: "text", text: "Done." },
        { type: "done", text: "" },
      ],
    });
    expect(sentTexts(messages)).toEqual(["Reply one."]);
  });

  it("starts the interim-message budget again after it", async () => {
    const notes = ["One.", "Two.", "Three.", "Four."].flatMap((text, index) => [
      { type: "text" as const, text },
      { type: "tool" as const, name: "read_file", args: {}, executionId: `before-${index}` },
    ]);
    const { messages } = await runTurn("", false, undefined, [], "fyi", {
      startedAt: new Date(Date.now() - 120_000),
      runtimeEvents: [
        ...notes,
        { type: "steered", fromRunUser: true },
        { type: "text", text: "Switching to the new list." },
        { type: "tool", name: "read_file", args: {}, executionId: "after-1" },
        { type: "text", text: "Done." },
        { type: "done", text: "" },
      ],
    });
    expect(sentTexts(messages)).toEqual(["One.", "Two.", "Three.", "Switching to the new list."]);
  });
});

describe("text from assistant messages with no tool call between them", () => {
  it("keeps a paragraph break and leaves each message's deltas as streamed", async () => {
    const { finalizeRun, append } = await runTurn("", false, undefined, [], "fyi", {
      runtimeEvents: [
        { type: "text", text: "Do" },
        { type: "text", text: "ne." },
        { type: "turn" },
        { type: "text", text: "That" },
        { type: "text", text: "'s it." },
        { type: "done", text: "Done.That's it." },
      ],
    });
    const saved = finalizeRun.mock.calls[0]![0].blocks.filter((block) => block.kind === "text")
      .map((block) => block.text)
      .join("");
    const streamed = append.mock.calls
      .map(([event]) => event)
      .filter((event) => event.type === "thread.progress")
      .map((event) => {
        const payload = event.payload as { text?: string; delta?: string };
        return payload.text ?? payload.delta ?? "";
      })
      .join("");
    expect(saved).toBe("Done.\n\nThat's it.");
    expect(streamed).toBe("Done.\n\nThat's it.");
  });

  it("adds nothing when the next message already starts on a new line", async () => {
    const { finalizeRun } = await runTurn("", false, undefined, [], "fyi", {
      runtimeEvents: [
        { type: "text", text: "Done." },
        { type: "turn" },
        { type: "text", text: "\nThat's it." },
        { type: "done", text: "Done.\nThat's it." },
      ],
    });
    const saved = finalizeRun.mock.calls[0]![0].blocks.filter((block) => block.kind === "text")
      .map((block) => block.text)
      .join("");
    expect(saved).toBe("Done.\nThat's it.");
  });
});

describe("a stray NO_RESPONSE on runs that must reply", () => {
  const savedText = (finalizeRun: Awaited<ReturnType<typeof runTurn>>["finalizeRun"]) =>
    finalizeRun.mock.calls[0]![0].blocks.filter((block) => block.kind === "text")
      .map((block) => block.text)
      .join("");

  it("drops the sentinel a late follow-up message adds after a user run's final answer", async () => {
    const { finalizeRun } = await runTurn("", false, undefined, [], "fyi", {
      runtimeEvents: [
        { type: "text", text: "Saved the PDF: /tmp/report.pdf" },
        { type: "turn" },
        { type: "text", text: "NO_" },
        { type: "text", text: "RESPONSE" },
        { type: "done", text: "Saved the PDF: /tmp/report.pdfNO_RESPONSE" },
      ],
    });
    expect(savedText(finalizeRun)).toBe("Saved the PDF: /tmp/report.pdf");
    expect(finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ markUnread: true }));
  });

  it("drops repeated sentinels glued onto a user run's final answer", async () => {
    const { finalizeRun } = await runTurn("", false, undefined, [], "fyi", {
      runtimeEvents: [
        { type: "text", text: "The report is ready." },
        { type: "text", text: "NO_RESPONSENO_RESPONSENO_RESPONSE" },
        { type: "done", text: "The report is ready.NO_RESPONSENO_RESPONSENO_RESPONSE" },
      ],
    });
    expect(savedText(finalizeRun)).toBe("The report is ready.");
  });

  it.each(["request", "question"] as const)(
    "tells the asker there is nothing new instead of relaying a bare sentinel (%s)",
    async (intent) => {
      vi.mocked(returnBotMessageOutcome).mockClear();
      const { finalizeRun } = await runTurn("NO_RESPONSE", true, undefined, [], intent, {
        trigger: "bot_message",
      });
      expect(savedText(finalizeRun)).toBe(PEER_NOTHING_NEW_REPLY);
      expect(returnBotMessageOutcome).toHaveBeenCalledExactlyOnceWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        PEER_NOTHING_NEW_REPLY,
        "result",
      );
    },
  );

  it("returns a peer request's result without the sentinel", async () => {
    vi.mocked(returnBotMessageOutcome).mockClear();
    const { finalizeRun } = await runTurn("", true, undefined, [], "request", {
      trigger: "bot_message",
      runtimeEvents: [
        { type: "text", text: "Done." },
        { type: "turn" },
        { type: "text", text: "NO_RESPONSE" },
        { type: "done", text: "Done.NO_RESPONSE" },
      ],
    });
    expect(savedText(finalizeRun)).toBe("Done.");
    expect(returnBotMessageOutcome).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      "Done.",
      "result",
    );
  });

  it.each(["Set the reply token to NO_RESPONSE and restart.", "NO_RESPONSE_POLICY is configured."])(
    "keeps the sentinel when it is part of the reply: %s",
    async (reply) => {
      const { finalizeRun } = await runTurn("", false, undefined, [], "fyi", {
        runtimeEvents: [
          { type: "text", text: reply },
          { type: "done", text: reply },
        ],
      });
      expect(savedText(finalizeRun)).toBe(reply);
    },
  );

  it("leaves a sentinel-only user reply as it is today", async () => {
    const { finalizeRun } = await runTurn("", false, undefined, [], "fyi", {
      runtimeEvents: [
        { type: "text", text: "NO_RESPONSE" },
        { type: "done", text: "NO_RESPONSE" },
      ],
    });
    expect(savedText(finalizeRun)).toBe("NO_RESPONSE");
  });
});

describe("helper settlement", () => {
  const helper: AgentRuntimeEvent = {
    type: "subagent",
    agentId: "helper",
    name: "Helper",
    task: "Check",
    status: "running",
  };
  it.each(["pause", "finish", "failure", "cancel"])(
    "persists stopped helpers on %s",
    async (exit) => {
      let now = Date.now();
      const clock = vi.spyOn(Date, "now").mockImplementation(() => (now += 2_000));
      const result = await runTurn("", false, "", [], "fyi", {
        runtimeEvents: [
          helper,
          ...(exit === "pause" ? [{ type: "ask" as const, text: "Continue?" }] : []),
        ],
        runtimeFailure: exit === "failure",
        runtimeCancel: exit === "cancel",
      }).finally(() => clock.mockRestore());
      const { savedEvents, messages, pauseRunForInput, finalizeRun } = result;
      const index = savedEvents.findIndex(
        (event) =>
          event.type === "thread.subagent" &&
          (event.payload as { status: string }).status === "failed",
      );
      expect(index).toBeGreaterThanOrEqual(0);
      expect(savedEvents[index]?.payload).toMatchObject({
        agentId: "helper",
        name: "Helper",
        task: "Check",
        status: "failed",
        result: "stopped",
      });
      expect(
        messages.flatMap((message) => message.blocks).filter((block) => block.kind === "subagent"),
      ).toEqual([
        expect.objectContaining({ agentId: "helper", status: "failed", result: "stopped" }),
      ]);
      if (exit === "pause") {
        expect(pauseRunForInput).toHaveBeenCalledOnce();
        expect(result.prisma.event.create.mock.invocationCallOrder[index]).toBeLessThan(
          pauseRunForInput.mock.invocationCallOrder[0]!,
        );
      } else if (exit !== "cancel") {
        expect(finalizeRun).toHaveBeenCalledOnce();
        expect(result.prisma.event.create.mock.invocationCallOrder[index]).toBeLessThan(
          finalizeRun.mock.invocationCallOrder[0]!,
        );
      }
    },
  );
  it("keeps ordinary history writes guarded after cancellation", async () => {
    const { prisma, append } = await runTurn("", false, "", [], "fyi", {
      runtimeEvents: [helper],
      runtimeCancel: true,
    });
    await expect(
      append({
        spaceId: "space-1",
        threadId: "thread-1",
        botId: "bot-1",
        runId: "run-1",
        type: "thread.subagent",
        payload: helper,
      }),
    ).rejects.toBeInstanceOf(RunHistoryWriteError);
    await expect(
      createThreadMessageInTransaction(prisma as unknown as Prisma.TransactionClient, {
        threadId: "thread-1",
        runId: "run-1",
        role: "bot",
        blocks: [{ kind: "text", text: "Late response" }],
      }),
    ).rejects.toBeInstanceOf(RunHistoryWriteError);
  });
});

describe("helper cleanup recovery", () => {
  const helpers: AgentRuntimeEvent[] = ["unavailable", "available"].map((agentId) => ({
    type: "subagent",
    agentId,
    name: "Helper",
    task: "Check",
    status: "running",
  }));
  it("continues cleanup after a helper write fails and never rejects cancellation", async () => {
    const result = await runTurn("", false, "", [], "fyi", {
      runtimeEvents: helpers,
      runtimeCancel: true,
      failHelperId: "unavailable",
    });
    expect(result.messages.flatMap((message) => message.blocks)).toContainEqual(
      expect.objectContaining({ kind: "subagent", agentId: "available", status: "failed" }),
    );
  });
  it("retries a failed message atomically without duplicate stopped blocks", async () => {
    const result = await runTurn("", false, "", [], "fyi", {
      runtimeEvents: helpers.slice(0, 1),
      failMessageOnce: true,
    });
    expect(
      result.messages
        .flatMap((message) => message.blocks)
        .filter((block) => block.kind === "subagent"),
    ).toHaveLength(1);
    expect(
      result.savedEvents.filter(
        (event) =>
          event.type === "thread.subagent" &&
          (event.payload as { status: string }).status === "failed",
      ),
    ).toHaveLength(1);
  });
});

describe("a run that fails partway through its reply", () => {
  const cut: AgentRuntimeEvent[] = [
    { type: "text", text: "Part one. " },
    { type: "text", text: "Part tw" },
  ];

  it("keeps the reply text the user saw as one message above the error", async () => {
    const { finalizeRun } = await runTurn("", false, "", [], "fyi", {
      runtimeEvents: cut,
      runtimeFailure: true,
    });
    expect(finalizeRun).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        outcome: "failed",
        error: "fixture runtime failure",
        partialReply: [{ kind: "text", text: "Part one. Part tw" }],
      }),
    );
  });

  it("keeps the text with secrets redacted", async () => {
    const { finalizeRun } = await runTurn("", false, "", ["canary-secret-4471"], "fyi", {
      runtimeEvents: [{ type: "text", text: "The key is canary-secret-4471 and the" }],
      runtimeFailure: true,
    });
    const [input] = finalizeRun.mock.calls[0] as unknown as [{ partialReply: MessageBlock[] }];
    expect(JSON.stringify(input.partialReply)).not.toContain("canary-secret-4471");
    expect(input.partialReply).toEqual([
      expect.objectContaining({ kind: "text", text: expect.stringContaining("The key is") }),
    ]);
  });

  it.each(["routine", "bot_message"])(
    "keeps nothing on a %s run, which shows no reply live",
    async (trigger) => {
      const { finalizeRun } = await runTurn("", false, "", [], "fyi", {
        trigger,
        runtimeEvents: cut,
        runtimeFailure: true,
      });
      expect(finalizeRun).toHaveBeenCalledExactlyOnceWith(
        expect.not.objectContaining({ partialReply: expect.anything() }),
      );
    },
  );

  it("keeps nothing when no reply text streamed", async () => {
    const { finalizeRun } = await runTurn("", false, "", [], "fyi", {
      runtimeEvents: [],
      runtimeFailure: true,
    });
    expect(finalizeRun).toHaveBeenCalledExactlyOnceWith(
      expect.not.objectContaining({ partialReply: expect.anything() }),
    );
  });

  it("shows no database text, server path or stack in the run error", async () => {
    const database = Object.assign(
      new Error(
        [
          "",
          "Invalid `tx.run.findUnique()` invocation in",
          "/app/packages/db/src/events.ts:1604:40",
          "",
          "  1603 const run = await tx.run.findUnique({",
          "Transaction API error: Transaction already closed.",
        ].join("\n"),
      ),
      { name: "PrismaClientKnownRequestError" },
    );
    const { finalizeRun } = await runTurn("", false, "", [], "fyi", {
      runtimeEvents: [],
      runtimeFailure: true,
      runtimeError: database,
    });
    expect(finalizeRun).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ outcome: "failed", error: "Internal server error" }),
    );
  });
});

describe("a kept partial reply in later history", () => {
  it("tells the model that reply was cut off, without changing other replies", async () => {
    const { runtimeRun } = await runTurn("Done.", false, [], [], "fyi", {
      history: [
        { id: "m1", seq: 1, role: "user", text: "Write the plan" },
        {
          id: "m2",
          seq: 2,
          role: "bot",
          text: "Part one. Part tw",
          clientNonce: partialReplyClientNonce("run-0"),
        },
        { id: "m3", seq: 3, role: "user", text: "continue" },
        { id: "m4", seq: 4, role: "bot", text: "A whole reply." },
      ],
    });
    const history = runtimeRun.mock.calls[0]?.[0].history ?? [];
    const content = (id: string) => history.find((entry) => entry.id === id)?.content;
    expect(content("m2")).toBe(`Part one. Part tw\n\n${PARTIAL_REPLY_NOTE}`);
    expect(content("m4")).toBe("A whole reply.");
  });
});

describe("public coarse thinking lifecycle", () => {
  it("coalesces explicit boundaries and keeps activity out of messages", async () => {
    const result = await runTurn("", false, "", [], "request", {
      runtimeEvents: [
        { type: "thinking", active: true },
        { type: "thinking", active: true },
        { type: "thinking", active: false },
        { type: "thinking", active: false },
        { type: "text", text: "Public answer." },
        { type: "done" },
      ],
    });
    const activity = result.savedEvents.filter((event) => event.type === "thread.meta");
    expect(activity.map(({ payload }) => payload)).toEqual([
      { activity: { thinking: true } },
      { activity: { thinking: false } },
    ]);
    expect(
      activity.every(
        ({ runId, threadId, botId }) =>
          runId === "run-1" && threadId === "thread-1" && botId === "bot-1",
      ),
    ).toBe(true);
    expect(JSON.stringify(result.messages)).not.toContain("thinking");
  });
  it.each<AgentRuntimeEvent>([
    { type: "text", text: "Public reply." },
    { type: "tool", name: "read_file", args: {}, executionId: "read-1" },
    { type: "progress", text: "Reading", activity: true },
    { type: "turn" },
    { type: "ask", text: "Which option?" },
    { type: "done" },
  ])("resets before $type even if a runtime omits its end marker", async (boundary) => {
    const result = await runTurn("", false, "", [], "request", {
      runtimeEvents: [{ type: "thinking", active: true }, boundary, { type: "done" }],
    });
    expect(
      result.savedEvents
        .filter((event) => event.type === "thread.meta")
        .map(({ payload }) => payload),
    ).toEqual([{ activity: { thinking: true } }, { activity: { thinking: false } }]);
  });
  it("resets on a runtime failure or exhausted iterator without a terminal marker", async () => {
    for (const runtimeFailure of [false, true]) {
      const result = await runTurn("", false, "", [], "request", {
        runtimeFailure,
        runtimeEvents: [{ type: "thinking", active: true }],
      });
      expect(
        result.savedEvents
          .filter((event) => event.type === "thread.meta")
          .map(({ payload }) => payload),
      ).toEqual([{ activity: { thinking: true } }, { activity: { thinking: false } }]);
    }
  });
  it("does not emit background thinking or accept arbitrary runtime metadata into public payloads", async () => {
    const privateMarker = {
      type: "thinking",
      active: true,
      text: "private fixture reasoning",
      partial: { content: "private" },
    } as AgentRuntimeEvent;
    const visible = await runTurn("", false, "", [], "request", {
      runtimeEvents: [privateMarker, { type: "done" }],
    });
    expect(
      visible.savedEvents
        .filter((event) => event.type === "thread.meta")
        .map(({ payload }) => payload),
    ).toEqual([{ activity: { thinking: true } }, { activity: { thinking: false } }]);
    expect(JSON.stringify(visible.savedEvents)).not.toContain("private fixture reasoning");
    const background = await runTurn("", true, "", [], "fyi", {
      trigger: "tickets",
      runtimeEvents: [privateMarker, { type: "done" }],
    });
    expect(background.savedEvents.some((event) => event.type === "thread.meta")).toBe(false);
  });
});

it("terminal cancellation wins over a runtime's open thinking marker", async () => {
  const result = await runTurn("", false, "", [], "request", {
    runtimeCancel: true,
    runtimeEvents: [{ type: "thinking", active: true }],
  });
  const payloads = result.savedEvents
    .filter((event) => event.type === "thread.meta")
    .map(({ payload }) => payload);
  expect(payloads[0]).toEqual({ activity: { thinking: true } });
  expect(result.finalizeRun).not.toHaveBeenCalledWith(
    expect.objectContaining({ outcome: "failed" }),
  );
});
