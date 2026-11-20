import { stopNativeThreadRuns } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import { ACTIVE_RUN_STATUSES } from "@rakazo/core";
import { THREAD_LOCK_TRANSACTION_OPTIONS } from "@rakazo/db";
import type { RouterDeps } from "./router.js";
import { cancelThreadRuns, finishThreadStop, stopThreadRuns } from "./threads/thread-stop.js";
import type { ThreadTarget } from "./threads/thread-target.js";

/** The authorized thread must stop its remote processes before publishing cancellation. */
export async function stopThreadExecutionRuns(
  deps: RouterDeps,
  actor: Actor,
  target: ThreadTarget,
) {
  await stopNativeThreadRuns(deps, actor.spaceId, target.threadId);
  await stopThreadRuns(deps, actor, target);
}

/** The route has authorized the bot owner and validated the destination before stopping work. */
export async function stopBotExecutionRuns(deps: RouterDeps, actor: Actor, botId: string) {
  const threads = await deps.prisma.run.findMany({
    where: { spaceId: actor.spaceId, botId, status: { in: [...ACTIVE_RUN_STATUSES] } },
    distinct: ["threadId"],
    select: { threadId: true },
  });
  await Promise.all(
    threads.map(async ({ threadId }) => {
      await stopNativeThreadRuns(deps, actor.spaceId, threadId, botId);
      const target = { kind: "bot" as const, botId, threadId };
      const cancelled = await deps.prisma.$transaction(
        cancelThreadRuns(actor, target, undefined, undefined, botId),
        THREAD_LOCK_TRANSACTION_OPTIONS,
      );
      await finishThreadStop(deps, actor, target, cancelled);
    }),
  );
}
