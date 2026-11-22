import { createHash } from "node:crypto";
import type { SkillRecord } from "@rakazo/core";
import { expandSkillReferencesInPrompt } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";

function promptFingerprint(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * What turning on "Use my computer" approves: the routine's prompt with its skills expanded, as
 * a timed run, Run now or an @mention gets it. A skill edit or a newly matching skill changes it.
 */
export function routineComputerFingerprint(prompt: string, skills: readonly SkillRecord[]): string {
  return promptFingerprint(expandSkillReferencesInPrompt(prompt, skills));
}

/**
 * Whether a routine run may use its owner's own computer: the owner turned it on for this routine
 * in the app, the routine, its bot and the run are all theirs, and the run carries exactly the text
 * they approved. Webhook, email, git and chat-app runs are not routine runs, and a watch's change
 * note or any edit changes the text. Such a run reads only its own prompt.
 */
export async function routineRunUsesOwnerComputer(
  prisma: PrismaClient,
  run: { trigger: string; routineId: string | null; userId: string; botId: string; taskId: string },
): Promise<boolean> {
  if (run.trigger !== "routine" || !run.routineId) return false;
  const routine = await prisma.routine.findUnique({
    where: { id: run.routineId },
    select: {
      userId: true,
      botId: true,
      inChat: true,
      watch: true,
      computerPromptHash: true,
      bot: { select: { userId: true } },
    },
  });
  if (
    !routine?.computerPromptHash ||
    routine.inChat ||
    routine.watch !== null ||
    routine.botId !== run.botId ||
    routine.userId !== run.userId ||
    routine.bot.userId !== run.userId
  )
    return false;
  const task = await prisma.task.findUnique({
    where: { id: run.taskId },
    select: { prompt: true },
  });
  return task ? promptFingerprint(task.prompt) === routine.computerPromptHash : false;
}
