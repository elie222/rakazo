import { PiAgentRuntime } from "@rakazo/adapters";
import type { PrismaClient } from "@rakazo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compactHistory } from "../../adapters/src/history-compaction.js";
import { startModelEmulator } from "./model-emulator.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("history compaction with real Pi", () => {
  it.each(["", "   "])("preserves history and retries an empty summary (%j)", async (text) => {
    const summary = "Earlier decisions and the new conversation facts.";
    const server = await startModelEmulator({
      steps: [text, summary].map((response) => ({
        expect(request) {
          expect(JSON.stringify(request.messages)).toContain("Earlier decisions.");
          expect(JSON.stringify(request.messages)).toContain("New conversation facts.");
        },
        response: { type: "text", text: response },
      })),
    });
    cleanups.push(() => server.close());
    const thread = {
      id: "fixture-thread",
      botId: "fixture-bot",
      spaceId: "fixture-space",
      userId: "fixture-user",
      nextMessageSeq: 51,
      historyCompactedUpToSeq: 49,
      historyCompactionGeneration: 0,
      historyCompactionSummary: "Earlier decisions.",
    };
    const updateMany = vi.fn(
      async (args: {
        data: { historyCompactedUpToSeq: number; historyCompactionSummary: string };
      }) => {
        Object.assign(thread, args.data);
        return { count: 1 };
      },
    );
    const prisma = {
      thread: { findUniqueOrThrow: vi.fn(async () => thread), updateMany },
      message: {
        findMany: vi.fn(async () => [
          {
            seq: 50,
            role: "user",
            blocks: [{ kind: "text", text: "New conversation facts." }],
          },
        ]),
      },
    };
    const memoryProviders = { resolve: vi.fn(async () => null) };
    const jobs = { enqueue: vi.fn(async () => undefined) };
    const deps = {
      prisma: prisma as unknown as PrismaClient,
      runtime: new PiAgentRuntime(),
      jobs,
      memoryProviders,
      resolveModel: async () => server.model,
    };

    await expect(compactHistory(deps, thread.id)).rejects.toThrow("summarizer returned no summary");
    expect(updateMany).not.toHaveBeenCalled();
    expect(thread.historyCompactedUpToSeq).toBe(49);
    expect(thread.historyCompactionSummary).toBe("Earlier decisions.");
    expect(memoryProviders.resolve).not.toHaveBeenCalled();
    expect(jobs.enqueue).not.toHaveBeenCalled();

    await compactHistory(deps, thread.id);
    server.assertComplete();
    expect(updateMany).toHaveBeenCalledExactlyOnceWith({
      where: {
        id: thread.id,
        historyCompactedUpToSeq: 49,
        historyCompactionGeneration: 0,
      },
      data: { historyCompactedUpToSeq: 50, historyCompactionSummary: summary },
    });
    expect(memoryProviders.resolve).toHaveBeenCalledOnce();
    expect(jobs.enqueue).not.toHaveBeenCalled();
  });
});
