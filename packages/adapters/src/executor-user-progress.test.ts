import type { AgentRunRequest, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import type { AppendEventInput, Prisma } from "@rakazo/db";
import {
  appendEventInTransaction,
  createThreadMessageInTransaction,
  RunHistoryWriteError,
} from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { loadBotMessageContext, returnBotMessageOutcome } from "./bot-messages.js";
import type * as ComputerLifecycleModule from "./computer-lifecycle.js";
import { createRunExecutor } from "./executor.js";
import { createJobReconciler } from "./job-reconciler.js";
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
    runtimeCancel?: boolean;
    failHelperId?: string;
    failMessageOnce?: boolean;
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
  };
  const runtimeRun = vi.fn(async function* (_request: AgentRunRequest) {
    if (options.runtimeEvents) {
      for (const event of options.runtimeEvents) {
        yield event;
      }
      if (options.runtimeCancel) {
        run.status = "cancelled";
        yield { type: "done" as const };
      }
      if (options.runtimeFailure) throw new Error("fixture runtime failure");
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
        where.runId === run.id && options.priorProgressText
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
    spaceModelPreference: {
      findFirst: vi.fn<(...args: unknown[]) => Promise<Record<string, unknown> | null>>(
        async () => null,
      ),
    },
    secret: { findFirst: vi.fn(async () => null) },
    userModelCredential: { findFirst: vi.fn(async () => null) },
    spaceBackupModel: { findMany: vi.fn(async () => []) },
    deploymentSettings: {
      findUnique: vi.fn(async () => ({
        defaultModelProvider: "openrouter",
        defaultModelId: "fixture-model",
      })),
    },
    taughtSkill: { findMany: vi.fn(async () => []) },
    agentSecret: { findMany: vi.fn(async () => []) },
    botSecret: { findMany: vi.fn(async () => []) },
    agentSkill: { findMany: vi.fn(async () => []) },
    scratchpadItem: { findMany: vi.fn(async () => []) },
    externalEffect: { findMany: vi.fn(async () => []) },
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
  const append = vi.fn(async (event: AppendEventInput) =>
    appendEventInTransaction(prisma as unknown as Prisma.TransactionClient, event),
  );
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
  return { finalizeRun, append, pauseRunForInput, messages, savedEvents, prisma };
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
  it.each(["", "Checked: all clear."])("keeps pre-tool text with final %j", async (finalText) => {
    const { finalizeRun } = await runTurn(finalText, false);
    const text = finalizeRun.mock.calls[0]![0].blocks.filter((block) => block.kind === "text")
      .map((block) => block.text)
      .join("");
    expect(text).toBe(`I will check that.${finalText ? `\n\n${finalText}` : ""}`);
  });
});

describe("text from separate assistant turns", () => {
  it.each(["The draft is posted.", "The draft is posted at https://example.com/drafts/42"])(
    "keeps a paragraph break after %j in finalized blocks",
    async (narration) => {
      const { finalizeRun } = await runTurn("Nothing has changed since then.", false, narration);
      const text = finalizeRun.mock.calls[0]![0].blocks.filter((block) => block.kind === "text")
        .map((block) => block.text)
        .join("");
      expect(text).toBe(`${narration}\n\nNothing has changed since then.`);
    },
  );

  it("streams the break when the redactor holds all pre-tool text", async () => {
    const narration = "I will check that.";
    const finalText = "Checked: all clear.";
    const { append } = await runTurn(finalText, false, narration, [
      "fake-secret-longer-than-the-entire-reply-for-redactor-buffering",
    ]);
    const text = append.mock.calls
      .map(([event]) => event)
      .filter((event) => event.type === "thread.progress")
      .map((event) => {
        const payload = event.payload as { text?: string; delta?: string };
        return payload.text ?? payload.delta ?? "";
      })
      .join("");
    expect(text).toBe(`${narration}\n\n${finalText}`);
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
