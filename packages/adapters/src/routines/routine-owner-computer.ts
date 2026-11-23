import { createHash } from "node:crypto";
import type { SkillRecord } from "@rakazo/core";
import { expandSkillReferencesInPrompt } from "@rakazo/core";
import type { Prisma, PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { advisoryLock } from "../locks/advisory-lock.js";

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
 * Held while turning "Use my computer" on, from the pairing check to the write. The trigger that
 * clears approvals when the owner pairs or unpairs a computer takes the same lock
 * (`pg_advisory_xact_lock(hashtext('routine_computer'), hashtext("userId"))`), so a device change
 * either lands first and the check sees it, or waits and clears the approval after it is written.
 */
export function lockOwnerComputerApproval(tx: Prisma.TransactionClient, userId: string) {
  return advisoryLock(tx, "routine_computer", userId);
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

/** Why a routine can't use its owner's computer. */
export type OwnerComputerRefusal =
  | "in_chat"
  | "watch"
  | "other_owner"
  | "group"
  | "event_routines"
  | "text_changed";

/**
 * The one rule for "Use my computer", checked when it is turned on, when the editor shows it and
 * when a run starts: the routine and its bot belong to whoever would get the computer, it runs in
 * no chat and watches nothing, its chat is no group, its bot has no routine that outside events
 * start, and the text matches what the owner approved. Null when it may.
 */
export function ownerComputerRefusal(routine: {
  /** Whose computer it would use: the run's, the viewer's or the editor's user. */
  ownerId: string;
  userId: string;
  botUserId: string;
  inChat: boolean;
  watch: unknown;
  groupThread: boolean;
  botEventRoutines: boolean;
  /** The approved fingerprint; undefined while it is being approved. */
  approved?: string | null;
  /** The fingerprint of the text a run gets; null when it names a skill. */
  current: string | null;
}): OwnerComputerRefusal | null {
  if (routine.inChat) return "in_chat";
  if (routine.watch !== null) return "watch";
  if (routine.userId !== routine.ownerId || routine.botUserId !== routine.ownerId)
    return "other_owner";
  if (routine.groupThread) return "group";
  if (routine.botEventRoutines) return "event_routines";
  if (routine.current === null) return "text_changed";
  if (routine.approved !== undefined && routine.approved !== routine.current) return "text_changed";
  return null;
}

/**
 * Whether a routine run may use its owner's own computer: the owner turned it on for this routine
 * in the app and the run is this routine's, by its owner, in its bot (see ownerComputerRefusal).
 * Webhook, email, git and chat-app runs are not routine runs. Such a run reads only its own prompt.
 */
export async function routineRunUsesOwnerComputer(
  prisma: PrismaClient,
  run: {
    trigger: string;
    routineId: string | null;
    userId: string;
    botId: string;
    taskId: string;
    threadId: string;
  },
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
  const [task, eventRoutines, thread] = await Promise.all([
    prisma.task.findUnique({ where: { id: run.taskId }, select: { prompt: true } }),
    prisma.routine.count({ where: botEventRoutines([run.botId]) }),
    prisma.thread.findUnique({ where: { id: run.threadId }, select: { groupId: true } }),
  ]);
  const refused =
    routine.botId !== run.botId
      ? "other_bot"
      : ownerComputerRefusal({
          ownerId: run.userId,
          userId: routine.userId,
          botUserId: routine.bot.userId,
          inChat: routine.inChat,
          watch: routine.watch,
          groupThread: !thread || thread.groupId !== null,
          botEventRoutines: eventRoutines > 0,
          approved: routine.computerPromptHash,
          current: task ? promptFingerprint(task.prompt) : null,
        });
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
