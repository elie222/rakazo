import { createHash } from "node:crypto";
import type { SkillRecord } from "@rakazo/core";
import { expandSkillReferencesInPrompt } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

function promptFingerprint(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * What turning on "Use my computer" approves: the routine's prompt exactly as the owner saw it.
 * Null when the prompt names a skill, whose text the owner never sees, so a newly matching skill
 * changes what a run gets and it no longer matches.
 */
export function routineComputerFingerprint(
  prompt: string,
  skills: readonly SkillRecord[],
): string | null {
  return expandSkillReferencesInPrompt(prompt, skills) === prompt
    ? promptFingerprint(prompt)
    : null;
}

/**
 * The bot's routines that outside events start (a webhook, email, git push or chat-app message).
 * Those runs can leave text the bot's later runs read, so while any is on, no routine of that bot
 * gets its owner's computer.
 */
export function botEventRoutines(botIds: string[]) {
  return {
    botId: { in: botIds },
    OR: [
      { webhookEnabled: true },
      { githubEnabled: true },
      { messageProvider: { not: null } },
      { emailSenders: { not: null } },
    ],
  };
}

/**
 * Whether a routine run may use its owner's own computer: the owner turned it on for this routine
 * in the app, the routine, its bot and the run are all theirs, and the run carries exactly the text
 * they approved. Webhook, email, git and chat-app runs are not routine runs, and while the bot has
 * any, none of its routines qualify. A watch's change note or any edit changes the text. Such a run
 * reads only its own prompt.
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
  if (!routine?.computerPromptHash) return false;
  const [task, eventRoutines] = await Promise.all([
    prisma.task.findUnique({ where: { id: run.taskId }, select: { prompt: true } }),
    prisma.routine.count({ where: botEventRoutines([run.botId]) }),
  ]);
  const refused = routine.inChat
    ? "in_chat"
    : routine.watch !== null
      ? "watch"
      : routine.botId !== run.botId
        ? "other_bot"
        : routine.userId !== run.userId || routine.bot.userId !== run.userId
          ? "other_owner"
          : eventRoutines > 0
            ? "event_routines"
            : task === null || promptFingerprint(task.prompt) !== routine.computerPromptHash
              ? "text_changed"
              : null;
  if (refused) {
    // The switch is on but this run won't get the computer, so say why.
    getLogger().info("routine.owner_computer_refused", {
      "routine.id": run.routineId,
      "task.id": run.taskId,
      reason: refused,
    });
  }
  return refused === null;
}
