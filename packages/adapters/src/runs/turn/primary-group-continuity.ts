import type { AgentRunRequest } from "@rakazo/adapter-kit";
import { redactSecrets } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { readMessageBlocks } from "@rakazo/db";

const MAX_PRIOR_TURNS = 3;
const MAX_MESSAGE_CHARS = 2_000;

function boundedText(
  message: Parameters<typeof readMessageBlocks>[0],
  redactions: readonly string[],
) {
  const { blocks, intact } = readMessageBlocks(message);
  const [block] = blocks;
  if (!intact || blocks.length !== 1 || block?.kind !== "text") return;
  return redactSecrets(block.text, redactions).trim().slice(0, MAX_MESSAGE_CHARS) || undefined;
}

/** Replay canonical, completed owner mentions, not native sessions or shared group history. */
export async function primaryGroupHistory(
  prisma: Pick<PrismaClient, "run" | "message">,
  input: {
    botId: string;
    spaceId: string;
    threadId: string;
    userId: string;
    primaryRuntime: string;
    modelProvider: string;
    modelId: string;
    modelCredentialId: string;
    beforeSeq: number;
    redactions: readonly string[];
  },
): Promise<AgentRunRequest["history"]> {
  const {
    botId,
    spaceId,
    threadId,
    userId,
    primaryRuntime,
    modelProvider,
    modelId,
    modelCredentialId,
    beforeSeq,
    redactions,
  } = input;
  const priorRuns = await prisma.run.findMany({
    where: {
      botId,
      spaceId,
      threadId,
      userId,
      primaryRuntime,
      modelProvider,
      modelId,
      modelCredentialId,
      modelPinned: true,
      status: "completed",
      trigger: "user",
      routineId: null,
      sourceMessage: { threadId, role: "user", authorUserId: userId, seq: { lt: beforeSeq } },
    },
    select: {
      id: true,
      sourceMessage: { select: { id: true, threadId: true, seq: true, blocks: true } },
    },
    orderBy: [{ sourceMessage: { seq: "desc" } }, { id: "desc" }],
    take: MAX_PRIOR_TURNS,
  });
  if (!priorRuns.length) return [];
  const replies = await prisma.message.findMany({
    where: {
      threadId,
      botId,
      role: "bot",
      clientNonce: null,
      runId: { in: priorRuns.map(({ id }) => id) },
      seq: { lt: beforeSeq },
    },
    // Use normal visible final replies only, never partial or tool-history payloads.
    select: { id: true, threadId: true, runId: true, seq: true, blocks: true },
    orderBy: { seq: "desc" },
    take: MAX_PRIOR_TURNS,
  });

  const history: AgentRunRequest["history"] = [];
  const seen = new Set<string>();
  for (const { id, sourceMessage } of priorRuns) {
    if (!sourceMessage || seen.has(sourceMessage.id)) continue;
    const reply = replies.find(
      (message) => message.runId === id && message.seq > sourceMessage.seq,
    );
    if (!reply) continue;
    const prompt = boundedText(sourceMessage, redactions);
    const response = boundedText(reply, redactions);
    if (!prompt || !response) continue;
    seen.add(sourceMessage.id);
    history.unshift(
      { id: sourceMessage.id, role: "user", content: prompt },
      { id: reply.id, role: "assistant", content: response },
    );
  }
  return history;
}
