import type { Prisma } from "../database/client.js";

/**
 * A routine that runs alongside its chat is its own run: it never makes a message, a follow-up
 * turn or a routine that runs in the chat wait for it. Every other active run does.
 */
export const HOLDS_CHAT: Prisma.RunWhereInput = {
  NOT: { trigger: "routine", routine: { is: { inChat: false } } },
};

/** The same rule for a run already read with its routine's `inChat`. */
export function runHoldsChat(run: {
  trigger: string | null;
  routine?: { inChat: boolean } | null;
}): boolean {
  return !(run.trigger === "routine" && run.routine && !run.routine.inChat);
}
