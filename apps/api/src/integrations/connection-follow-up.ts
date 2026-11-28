import type { Actor } from "@rakazo/contracts";
import type { Prisma } from "@rakazo/db";

/** Record a hidden turn in the same transaction that resolves the connection card. */
export async function queueConnectionFollowUp(
  tx: Prisma.TransactionClient,
  actor: Actor,
  input: { botId: string; threadId: string; prompt: string } & (
    | { trigger: "user" }
    | { trigger: "follow_up"; clientNonce: string; sourceMessageId?: string }
  ),
) {
  const { botId, threadId, prompt, ...runInput } = input;
  const owner = { spaceId: actor.spaceId, userId: actor.userId, botId, threadId };
  const task = await tx.task.create({
    data: { ...owner, prompt, status: "queued" },
  });
  const run = await tx.run.create({
    data: { ...owner, taskId: task.id, status: "queued", ...runInput },
    select: { id: true },
  });
  return run.id;
}
