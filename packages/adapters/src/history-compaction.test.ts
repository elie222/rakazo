import { describe, expect, it, vi } from "vitest";
import type { AgentRuntime } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import {
  compactHistory,
  historyWindowSize,
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
    expect(shouldEnqueueCompaction(149, 50, 50, 50)).toBe(false);
    expect(shouldEnqueueCompaction(150, 50, 50, 50)).toBe(true);
  });
});

describe("nextCompactionBatchRange", () => {
  it("starts from the beginning when nothing has been compacted", () => {
    expect(nextCompactionBatchRange(null, 50)).toEqual({ fromSeqExclusive: 0, take: 50 });
  });

  it("continues from the cursor when something has already been compacted", () => {
    expect(nextCompactionBatchRange(50, 50)).toEqual({ fromSeqExclusive: 50, take: 50 });
  });
});

describe("historyWindowSize", () => {
  it("uses the smaller Supermemory window when enabled", () => {
    expect(historyWindowSize(true)).toBe(50);
  });

  it("uses the legacy 200-message window when Supermemory is not configured", () => {
    expect(historyWindowSize(false)).toBe(200);
  });
});

function compactionHarness(options: { deploymentModelKey?: string; settings?: { defaultModelProvider: string | null; defaultModelId: string | null } | null } = {}) {
  const thread = {
    id: "thread-1",
    botId: "bot-1",
    historyCompactedUpToSeq: null as number | null,
  };
  const messages = Array.from({ length: 50 }, (_, i) => ({
    seq: i,
    role: i % 2 === 0 ? "user" : "bot",
    blocks: [{ kind: "text", text: `message ${i}` }],
  }));
  const prisma = {
    thread: {
      findUniqueOrThrow: vi.fn(async () => thread),
      update: vi.fn(async (args) => {
        thread.historyCompactedUpToSeq = args.data.historyCompactedUpToSeq;
        return thread;
      }),
    },
    message: {
      findMany: vi.fn(async () => messages),
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
  const saveSupermemoryMemory = vi.fn<() => Promise<SupermemorySaveResponse>>(
    async () => ({ ok: true }),
  );
  return {
    thread,
    messages,
    prisma,
    runtime,
    saveSupermemoryMemory,
    deps: {
      prisma: prisma as unknown as PrismaClient,
      runtime: runtime as unknown as AgentRuntime,
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

    expect(harness.prisma.thread.update).toHaveBeenCalledWith({
      where: { id: "thread-1" },
      data: { historyCompactedUpToSeq: 49 },
    });
  });

  it("falls back to the deployment's configured default model when no cloud credential is available (covers a keyless local-mlx/Ollama default)", async () => {
    const harness = compactionHarness({
      settings: { defaultModelProvider: "local-mlx", defaultModelId: "mlx-community/Qwen3.8-27B-4bit" },
    });

    await compactHistory(harness.deps, "thread-1");

    const [request] = harness.runtime.run.mock.calls[0]!;
    expect(request.model).toEqual({
      provider: "local-mlx",
      id: "mlx-community/Qwen3.8-27B-4bit",
      apiKey: undefined,
    });
  });

  it("falls back to the scripted runtime only when nothing at all is configured", async () => {
    const harness = compactionHarness();

    await compactHistory(harness.deps, "thread-1");

    const [request] = harness.runtime.run.mock.calls[0]!;
    expect(request.model).toEqual({ provider: "scripted", id: "scripted", apiKey: undefined });
  });

  it("does not advance the cursor if saving to Supermemory fails", async () => {
    const harness = compactionHarness({ deploymentModelKey: "openrouter-key" });
    harness.saveSupermemoryMemory.mockResolvedValueOnce({ ok: false, error: "network error" });

    await expect(compactHistory(harness.deps, "thread-1")).rejects.toThrow();

    expect(harness.prisma.thread.update).not.toHaveBeenCalled();
  });
});
