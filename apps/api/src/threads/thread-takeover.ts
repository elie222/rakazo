import { ORPCError } from "@orpc/server";
import type { Actor } from "@rakazo/contracts";
import { answerComputerRequest } from "../computers/computer-control.js";
import type { RouterDeps } from "../router.js";
import type { ThreadTarget } from "./thread-target.js";

/** A chat reply hands the screen back to the bot whose run it steers, in a group as in a DM. */
export function takeoverReleaser(deps: RouterDeps, actor: Actor, target: ThreadTarget) {
  return async (runId: string) => {
    const botId =
      target.kind === "bot"
        ? target.botId
        : (
            await deps.prisma.run.findUnique({
              where: { id: runId, spaceId: actor.spaceId },
              select: { botId: true },
            })
          )?.botId;
    if (!botId) return;
    // A reply from someone the bot did not ask still steers it, but answers nothing.
    await answerComputerRequest(deps, actor, botId, "done", runId).catch((error: unknown) => {
      if (!(error instanceof ORPCError)) throw error;
    });
  };
}
