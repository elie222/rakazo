import { ExecutionProfileSnapshotSchema } from "@rakazo/contracts";
import type { PrismaClient } from "./client.js";

export type ExecutionHandover = {
  previousHarness: string;
  currentHarness: string;
  summary: string;
};

type HandoverScope = {
  id: string;
  spaceId: string;
  userId: string;
  botId: string;
  threadId: string;
};

/** Only canonical, same-bot/thread run metadata crosses a harness switch. */
export async function resolveExecutionHandover(
  prisma: Pick<PrismaClient, "run">,
  scope: HandoverScope,
): Promise<ExecutionHandover | null> {
  const current = await prisma.run.findFirst({
    where: {
      id: scope.id,
      spaceId: scope.spaceId,
      userId: scope.userId,
      botId: scope.botId,
      threadId: scope.threadId,
    },
    select: { startedAt: true, executionProfileSnapshot: true },
  });
  if (!current?.startedAt) return null;
  const previous = await prisma.run.findFirst({
    where: {
      spaceId: scope.spaceId,
      userId: scope.userId,
      botId: scope.botId,
      threadId: scope.threadId,
      id: { not: scope.id },
      startedAt: { lt: current.startedAt },
    },
    orderBy: [{ startedAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
    select: { executionProfileSnapshot: true },
  });
  if (!previous) return null;
  const before = ExecutionProfileSnapshotSchema.safeParse(previous.executionProfileSnapshot);
  const after = ExecutionProfileSnapshotSchema.safeParse(current.executionProfileSnapshot);
  const previousProfile = before.success ? before.data.profileId : null;
  const currentProfile = after.success ? after.data.profileId : null;
  if (previousProfile === currentProfile) return null;
  const previousHarness = before.success ? before.data.harness : "pi";
  const currentHarness = after.success ? after.data.harness : "pi";
  return {
    previousHarness,
    currentHarness,
    summary:
      `Execution handover: ${previousHarness} → ${currentHarness}. ` +
      "The execution profile changed. Use the supplied canonical conversation, task results, " +
      "and authorized artifact references as continuity context. Native session state is not " +
      "transferred between profiles. Preserve unfinished work and verify outcomes before repeating actions.",
  };
}
