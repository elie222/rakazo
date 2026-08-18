import type { AgentRuntime } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import {
  saveSupermemoryMemory as defaultSaveSupermemoryMemory,
  supermemoryContainerTag,
} from "./supermemory-client.js";

export function shouldEnqueueCompaction(
  nextMessageSeq: number,
  historyCompactedUpToSeq: number | null,
  windowSize: number,
  batchSize: number,
): boolean {
  const compactedUpTo = historyCompactedUpToSeq ?? 0;
  return nextMessageSeq - compactedUpTo >= windowSize + batchSize;
}

export function nextCompactionBatchRange(
  historyCompactedUpToSeq: number | null,
  batchSize: number,
): { fromSeqExclusive: number; take: number } {
  return { fromSeqExclusive: historyCompactedUpToSeq ?? 0, take: batchSize };
}

export const COMPACTION_BATCH_SIZE = 50;

export interface CompactHistoryDeps {
  prisma: PrismaClient;
  runtime: AgentRuntime;
  deploymentModelKey?: string;
  saveSupermemoryMemory?: typeof defaultSaveSupermemoryMemory;
}

export async function compactHistory(deps: CompactHistoryDeps, threadId: string): Promise<void> {
  const thread = await deps.prisma.thread.findUniqueOrThrow({ where: { id: threadId } });
  const { fromSeqExclusive, take } = nextCompactionBatchRange(
    thread.historyCompactedUpToSeq,
    COMPACTION_BATCH_SIZE,
  );
  const batch = await deps.prisma.message.findMany({
    where: { threadId, seq: { gt: fromSeqExclusive } },
    orderBy: { seq: "asc" },
    take,
    select: { seq: true, role: true, blocks: true },
  });
  if (batch.length === 0) return;

  const transcript = batch
    .map((message) => {
      const text = (message.blocks as Array<{ kind?: string; text?: string }>)
        .filter((block) => typeof block.text === "string")
        .map((block) => block.text)
        .join("\n");
      return `${message.role}: ${text}`;
    })
    .join("\n\n");

  // Platform default (OpenRouter) when a usable cloud credential exists. Otherwise fall back to
  // the deployment's own configured default model — this is how a keyless local-mlx/Ollama model
  // set up during onboarding gets used for compaction too, rather than silently doing nothing.
  // "scripted" (a no-op test runtime, not a real model) is the last-resort fallback only when
  // truly nothing is configured — matching the same final fallback the main run loop itself uses.
  const model = deps.deploymentModelKey
    ? {
        provider: "openrouter",
        id: "deepseek/deepseek-v4-flash-0731",
        apiKey: deps.deploymentModelKey,
      }
    : await (async () => {
        const settings = await deps.prisma.deploymentSettings.findUnique({
          where: { id: "default" },
        });
        return {
          provider: settings?.defaultModelProvider ?? "scripted",
          id: settings?.defaultModelId ?? "scripted",
          apiKey: undefined,
        };
      })();

  let summary = "";
  for await (const event of deps.runtime.run(
    {
      botId: thread.botId,
      threadId,
      runId: `compact:${threadId}:${fromSeqExclusive}`,
      prompt: transcript,
      instructions:
        "Summarize the following stretch of conversation into a concise, factual memory capturing key facts, decisions, and context. Do not add commentary or preamble — output only the summary.",
      history: [],
      tools: [],
      model,
    },
    {
      operationId: `compact:${threadId}`,
      traceId: `compact:${threadId}`,
      workspaceId: "",
      userId: "",
      signal: new AbortController().signal,
    },
  )) {
    if (event.type === "done" && event.text) summary = event.text;
  }
  if (!summary) return;

  const save = deps.saveSupermemoryMemory ?? defaultSaveSupermemoryMemory;
  const result = await save(summary, supermemoryContainerTag(thread.botId));
  if (!result.ok) throw new Error(`Failed to save compacted memory: ${result.error}`);

  const lastSeq = batch[batch.length - 1]!.seq;
  await deps.prisma.thread.update({
    where: { id: threadId },
    data: { historyCompactedUpToSeq: lastSeq },
  });
}
