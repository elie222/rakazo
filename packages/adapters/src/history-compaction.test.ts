import type { AgentRuntime, JobPublisher } from "@rakazo/adapter-kit";
import { historyCompactJob } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  compactHistory,
  formatRecalledMemory,
  historyWindowSize,
  MAX_TRANSCRIPT_CHARS,
  nextCompactionBatchRange,
  shouldEnqueueCompaction,
} from "./history-compaction.js";
import type { SupermemorySaveResponse } from "./supermemory-client.js";

describe("shouldEnqueueCompaction", () => {
  it("is false when nothing has aged out of the window yet", () => {
    expect(shouldEnqueueCompaction(99, null, 50, 50)).toBe(false);
  });

  it("is true once a full batch has aged out beyond the window", () => {
    expect(shouldEnqueueCompaction(100, null, 50, 50)).toBe(true);
  });

  it("accounts for messages already compacted", () => {
    // A cursor of 50 means seq 0..50 are compacted, so seq 51..150 (100 messages, reached at
    // nextMessageSeq 151) is the first point a full batch has aged out beyond the window.
    expect(shouldEnqueueCompaction(150, 50, 50, 50)).toBe(false);
    expect(shouldEnqueueCompaction(151, 50, 50, 50)).toBe(true);
  });
});

describe("nextCompactionBatchRange", () => {
  it("starts before the first message when nothing has been compacted", () => {
    expect(nextCompactionBatchRange(null, 50)).toEqual({ fromSeqExclusive: -1, take: 50 });
  });

  it("continues from the cursor when something has already been compacted", () => {
    expect(nextCompactionBatchRange(50, 50)).toEqual({ fromSeqExclusive: 50, take: 50 });
  });
});

describe("historyWindowSize", () => {
  it("uses the smaller window only after compaction and a successful recall", () => {
    expect(
      historyWindowSize({ supermemoryEnabled: true, compacted: true, recallSucceeded: true }),
    ).toBe(50);
  });

  it("keeps the legacy window until a thread has actually been compacted", () => {
    expect(
      historyWindowSize({ supermemoryEnabled: true, compacted: false, recallSucceeded: false }),
    ).toBe(200);
  });

  it("keeps the legacy window when recall fails so compacted facts are not dropped", () => {
    expect(
      historyWindowSize({ supermemoryEnabled: true, compacted: true, recallSucceeded: false }),
    ).toBe(200);
  });

  it("uses the legacy 200-message window when Supermemory is not configured", () => {
    expect(
      historyWindowSize({ supermemoryEnabled: false, compacted: true, recallSucceeded: true }),
    ).toBe(200);
  });
});

describe("formatRecalledMemory", () => {
  it("formats results into a durable-memory-style block", () => {
    const block = formatRecalledMemory([
      { memory: "User prefers conventional commits." },
      { memory: "The VoC project's active repos are voc-backend, voc-brain, voc-frontend." },
    ]);
    expect(block).toContain("<recalled_memory>");
    expect(block).toContain("User prefers conventional commits.");
    expect(block).toContain("</recalled_memory>");
  });

  it("caps injected results at 5", () => {
    const results = Array.from({ length: 8 }, (_, i) => ({ memory: `fact ${i}` }));
    const block = formatRecalledMemory(results);
    expect(block).toContain("fact 4");
    expect(block).not.toContain("fact 5");
  });

  it("returns an empty string for no results", () => {
    expect(formatRecalledMemory([])).toBe("");
  });
});

type HarnessMessage = {
  seq: number;
  role: string;
  blocks: Array<{ kind: string; text: string }>;
};

function compactionHarness(
  options: {
    deploymentModelKey?: string;
    settings?: { defaultModelProvider: string | null; defaultModelId: string | null } | null;
    messages?: HarnessMessage[];
    nextMessageSeq?: number;
  } = {},
) {
  const messages =
    options.messages ??
    Array.from({ length: 50 }, (_, i) => ({
      seq: i,
      role: i % 2 === 0 ? "user" : "bot",
      blocks: [{ kind: "text", text: `message ${i}` }],
    }));
  const thread = {
    id: "thread-1",
    botId: "bot-1",
    workspaceId: "workspace-1",
    userId: "user-1",
    nextMessageSeq: options.nextMessageSeq ?? messages.length,
    historyCompactedUpToSeq: null as number | null,
  };
  const prisma = {
    thread: {
      findUniqueOrThrow: vi.fn(async () => thread),
      updateMany: vi.fn(
        async (args: {
          where: { historyCompactedUpToSeq: number | null };
          data: { historyCompactedUpToSeq: number };
        }) => {
          if (thread.historyCompactedUpToSeq !== args.where.historyCompactedUpToSeq) {
            return { count: 0 };
          }
          thread.historyCompactedUpToSeq = args.data.historyCompactedUpToSeq;
          return { count: 1 };
        },
      ),
    },
    message: {
      findMany: vi.fn(async (args: { where: { seq: { gt: number } }; take: number }) =>
        messages.filter((message) => message.seq > args.where.seq.gt).slice(0, args.take),
      ),
    },
    deploymentSettings: {
      findUnique: vi.fn(async () => options.settings ?? null),
    },
  };
  const runtime = {
    run: vi.fn<AgentRuntime["run"]>(async function* () {
      yield { type: "done", text: "Summary of 50 messages." };
    }),
  };
  const saveSupermemoryMemory = vi.fn<() => Promise<SupermemorySaveResponse>>(async () => ({
    ok: true,
  }));
  const jobs = { enqueue: vi.fn(async () => undefined) };
  return {
    thread,
    messages,
    prisma,
    runtime,
    saveSupermemoryMemory,
    jobs,
    deps: {
      prisma: prisma as unknown as PrismaClient,
      runtime: runtime as unknown as AgentRuntime,
      jobs: jobs as unknown as JobPublisher,
      deploymentModelKey: options.deploymentModelKey,
      saveSupermemoryMemory,
    },
  };
}

describe("compactHistory", () => {
  it("summarizes the next batch, saves it to Supermemory, and advances the cursor", async () => {
    const harness = compactionHarness({ deploymentModelKey: "openrouter-key" });

    await compactHistory(harness.deps, "thread-1");

    expect(harness.runtime.run).toHaveBeenCalledOnce();
    const [request] = harness.runtime.run.mock.calls[0]!;
    expect(request.tools).toEqual([]);
    expect(request.model).toEqual({
      provider: "openrouter",
      id: "deepseek/deepseek-v4-flash-0731",
      apiKey: "openrouter-key",
    });
    expect(request.prompt).toContain("message 0");
    expect(request.prompt).toContain("message 49");

    expect(harness.saveSupermemoryMemory).toHaveBeenCalledWith(
      "Summary of 50 messages.",
      "rakazo:bot-1",
    );

    const [, context] = harness.runtime.run.mock.calls[0]!;
    expect(context.workspaceId).toBe("workspace-1");
    expect(context.userId).toBe("user-1");

    expect(harness.prisma.thread.updateMany).toHaveBeenCalledWith({
      where: { id: "thread-1", historyCompactedUpToSeq: null },
      data: { historyCompactedUpToSeq: 49 },
    });
  });

  it("falls back to the deployment's configured default model when no cloud credential is available (covers a keyless local-mlx/Ollama default)", async () => {
    const harness = compactionHarness({
      settings: {
        defaultModelProvider: "local-mlx",
        defaultModelId: "mlx-community/Qwen3.8-27B-4bit",
      },
    });

    await compactHistory(harness.deps, "thread-1");

    const [request] = harness.runtime.run.mock.calls[0]!;
    expect(request.model).toEqual({
      provider: "local-mlx",
      id: "mlx-community/Qwen3.8-27B-4bit",
      apiKey: undefined,
    });
  });

  it("uses PI_DEFAULT_MODEL as the platform default summarizer when it is configured", async () => {
    const harness = compactionHarness({ deploymentModelKey: "openrouter-key" });
    const previous = process.env.PI_DEFAULT_MODEL;
    process.env.PI_DEFAULT_MODEL = "moonshotai/kimi-k2";
    try {
      await compactHistory(harness.deps, "thread-1");
    } finally {
      if (previous === undefined) delete process.env.PI_DEFAULT_MODEL;
      else process.env.PI_DEFAULT_MODEL = previous;
    }

    const [request] = harness.runtime.run.mock.calls[0]!;
    expect(request.model).toEqual({
      provider: "openrouter",
      id: "moonshotai/kimi-k2",
      apiKey: "openrouter-key",
    });
  });

  it("skips compaction entirely when nothing at all is configured, rather than summarizing with the scripted runtime", async () => {
    const harness = compactionHarness();

    await compactHistory(harness.deps, "thread-1");

    expect(harness.runtime.run).not.toHaveBeenCalled();
    expect(harness.saveSupermemoryMemory).not.toHaveBeenCalled();
    expect(harness.prisma.thread.updateMany).not.toHaveBeenCalled();
  });

  it("caps an oversized transcript at the budget, keeping the most recent content", async () => {
    const filler = "x".repeat(2_000);
    const harness = compactionHarness({
      deploymentModelKey: "openrouter-key",
      messages: Array.from({ length: 50 }, (_, i) => ({
        seq: i,
        role: "user",
        blocks: [{ kind: "text", text: `marker-${i} ${filler}` }],
      })),
    });

    await compactHistory(harness.deps, "thread-1");

    const [request] = harness.runtime.run.mock.calls[0]!;
    expect(request.prompt).toHaveLength(MAX_TRANSCRIPT_CHARS);
    expect(request.prompt).toContain("marker-49");
    expect(request.prompt).not.toContain("marker-0 ");
  });

  it("re-enqueues itself while a full batch of backlog still remains", async () => {
    const harness = compactionHarness({
      deploymentModelKey: "openrouter-key",
      nextMessageSeq: 150,
    });

    await compactHistory(harness.deps, "thread-1");

    expect(harness.jobs.enqueue).toHaveBeenCalledWith(historyCompactJob("thread-1"));
  });

  it("does not re-enqueue itself once the backlog no longer warrants compaction", async () => {
    const harness = compactionHarness({ deploymentModelKey: "openrouter-key" });

    await compactHistory(harness.deps, "thread-1");

    expect(harness.prisma.thread.updateMany).toHaveBeenCalledOnce();
    expect(harness.jobs.enqueue).not.toHaveBeenCalled();
  });

  it("does nothing when no uncompacted messages remain", async () => {
    const harness = compactionHarness({ deploymentModelKey: "openrouter-key", messages: [] });

    await compactHistory(harness.deps, "thread-1");

    expect(harness.runtime.run).not.toHaveBeenCalled();
    expect(harness.saveSupermemoryMemory).not.toHaveBeenCalled();
    expect(harness.prisma.thread.updateMany).not.toHaveBeenCalled();
    expect(harness.jobs.enqueue).not.toHaveBeenCalled();
  });

  it("does not save or advance the cursor when the summarizer returns no text", async () => {
    const harness = compactionHarness({ deploymentModelKey: "openrouter-key" });
    harness.runtime.run.mockImplementation(async function* () {
      yield { type: "done" };
    });

    await compactHistory(harness.deps, "thread-1");

    expect(harness.saveSupermemoryMemory).not.toHaveBeenCalled();
    expect(harness.prisma.thread.updateMany).not.toHaveBeenCalled();
  });

  it("propagates a summarizer failure so the job retries, and does not advance the cursor", async () => {
    const harness = compactionHarness({ deploymentModelKey: "openrouter-key" });
    harness.runtime.run.mockImplementation(async function* () {
      yield { type: "text", text: "partial" };
      throw new Error("summarizer unavailable");
    });

    await expect(compactHistory(harness.deps, "thread-1")).rejects.toThrow(
      "summarizer unavailable",
    );

    expect(harness.saveSupermemoryMemory).not.toHaveBeenCalled();
    expect(harness.prisma.thread.updateMany).not.toHaveBeenCalled();
  });

  it("does not advance the cursor if saving to Supermemory fails", async () => {
    const harness = compactionHarness({ deploymentModelKey: "openrouter-key" });
    harness.saveSupermemoryMemory.mockResolvedValueOnce({ ok: false, error: "network error" });

    await expect(compactHistory(harness.deps, "thread-1")).rejects.toThrow();

    expect(harness.prisma.thread.updateMany).not.toHaveBeenCalled();
  });

  it("does not advance or re-enqueue if another worker already moved the cursor", async () => {
    const harness = compactionHarness({
      deploymentModelKey: "openrouter-key",
      nextMessageSeq: 150,
    });
    harness.prisma.thread.updateMany.mockResolvedValueOnce({ count: 0 });

    await compactHistory(harness.deps, "thread-1");

    expect(harness.jobs.enqueue).not.toHaveBeenCalled();
  });
});
