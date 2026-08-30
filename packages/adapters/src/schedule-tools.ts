import type { JobPublisher } from "@rakazo/adapter-kit";
import { routineJobKey, routineWakeupJob } from "@rakazo/adapter-kit";
import {
  cronFromPreset,
  isOneShotRoutineCron,
  isOneShotRoutineCrons,
  nextCronDate,
  ONCE_ROUTINE_CRON,
} from "@rakazo/core";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";

export { isOneShotRoutineCron, ONCE_ROUTINE_CRON };

export const SCHEDULE_TOOL_NAMES = new Set(["schedule_create", "schedule_list", "schedule_cancel"]);

export function filterBuiltinToolsForRun<T extends { name: string }>(
  tools: T[],
  runTrigger: string,
): T[] {
  return runTrigger === "routine" ? tools.filter((tool) => tool.name !== "schedule_create") : tools;
}

/** Keep cross-bot messaging thread-specific while exposing schedules in DMs and groups. */
export function filterBuiltinToolsForThread<T extends { name: string }>(
  tools: T[],
  groupId: string | null | undefined,
): T[] {
  return tools.filter(
    (tool) =>
      (groupId || tool.name !== "handoff_to_bot") &&
      // In a group the room is the shared surface: hand the stage to a member
      // rather than starting a private thread off to one side.
      (!groupId || tool.name !== "message_bot"),
  );
}

type ScheduleUnit = "minutes" | "hours" | "days" | "seconds";

export type ResolvedSchedule =
  | { ok: true; cron: string; nextRunAt: Date; oneShot: boolean }
  | { ok: false; error: string };

export function resolveScheduleTiming(
  input: {
    cron?: unknown;
    every?: unknown;
    unit?: unknown;
    runAt?: unknown;
    delayMinutes?: unknown;
    delaySeconds?: unknown;
  },
  timezone = "UTC",
): ResolvedSchedule {
  const hasRepeat =
    input.cron !== undefined || input.every !== undefined || input.unit !== undefined;
  const hasOneShot =
    input.runAt !== undefined ||
    input.delayMinutes !== undefined ||
    input.delaySeconds !== undefined;
  if (hasRepeat && hasOneShot) {
    return {
      ok: false,
      error: "Provide either a repeating schedule or a one-shot time, not both.",
    };
  }
  if (!hasRepeat && !hasOneShot) {
    return {
      ok: false,
      error:
        "Provide cron, every/unit for repeating schedules, or runAt/delayMinutes/delaySeconds for one-shot.",
    };
  }

  if (hasOneShot) {
    const oneShotFields = [input.runAt, input.delayMinutes, input.delaySeconds].filter(
      (value) => value !== undefined,
    );
    if (oneShotFields.length !== 1) {
      return {
        ok: false,
        error:
          "Provide exactly one of runAt, delayMinutes, or delaySeconds for a one-shot schedule.",
      };
    }
    let nextRunAt: Date;
    if (input.delaySeconds !== undefined) {
      const delaySeconds = Number(input.delaySeconds);
      if (!Number.isFinite(delaySeconds) || delaySeconds < 0) {
        return { ok: false, error: "delaySeconds must be a non-negative number." };
      }
      nextRunAt = new Date(Date.now() + delaySeconds * 1_000);
    } else if (input.delayMinutes !== undefined) {
      const delayMinutes = Number(input.delayMinutes);
      if (!Number.isFinite(delayMinutes) || delayMinutes < 0) {
        return { ok: false, error: "delayMinutes must be a non-negative number." };
      }
      nextRunAt = new Date(Date.now() + delayMinutes * 60_000);
    } else {
      const parsed = new Date(String(input.runAt ?? ""));
      if (!Number.isFinite(parsed.getTime())) {
        return { ok: false, error: "runAt must be a valid ISO datetime." };
      }
      nextRunAt = parsed;
    }
    if (nextRunAt.getTime() <= Date.now()) {
      return { ok: false, error: "One-shot schedules must run in the future." };
    }
    return { ok: true, cron: ONCE_ROUTINE_CRON, nextRunAt, oneShot: true };
  }

  if (input.cron !== undefined) {
    const cron = String(input.cron).trim();
    if (!cron) return { ok: false, error: "cron must be a non-empty 5-field cron expression." };
    if (isOneShotRoutineCron(cron)) {
      return {
        ok: false,
        error: "Use runAt, delayMinutes, or delaySeconds for one-shot schedules.",
      };
    }
    const intervalError = validateRepeatingCron(cron);
    if (intervalError) return { ok: false, error: intervalError };
    try {
      const nextRunAt = nextCronDate(cron, new Date(), timezone);
      return { ok: true, cron, nextRunAt, oneShot: false };
    } catch {
      return { ok: false, error: "cron must be a valid 5-field cron expression." };
    }
  }

  const every = Number(input.every);
  const unit = String(input.unit ?? "") as ScheduleUnit;
  if (!Number.isFinite(every) || every <= 0 || !Number.isInteger(every)) {
    return { ok: false, error: "every must be a positive whole number." };
  }
  if (unit === "seconds") {
    return { ok: false, error: "minimum interval is 1 minute" };
  }
  if (!["minutes", "hours", "days"].includes(unit)) {
    return { ok: false, error: 'unit must be "minutes", "hours", or "days".' };
  }
  if (unit === "minutes" && every < 1) {
    return { ok: false, error: "minimum interval is 1 minute" };
  }
  const cron = cronFromPreset({ freq: "Interval", n: every, unit });
  const intervalError = validateRepeatingCron(cron);
  if (intervalError) return { ok: false, error: intervalError };
  try {
    const nextRunAt = nextCronDate(cron, new Date(), timezone);
    return { ok: true, cron, nextRunAt, oneShot: false };
  } catch {
    return { ok: false, error: "every/unit produced an invalid cron expression." };
  }
}

function validateRepeatingCron(cron: string): string | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return "cron must be a 5-field cron expression.";
  const minuteExpr = parts[0] ?? "*";
  const step = /^\*\/(\d+)$/.exec(minuteExpr);
  if (step) {
    const n = Number(step[1]);
    if (!Number.isFinite(n) || n < 1 || !Number.isInteger(n)) {
      return "minimum interval is 1 minute";
    }
  }
  return null;
}

export interface ScheduleToolDeps {
  prisma: PrismaClient;
  events: ThreadEvents;
  jobs: JobPublisher;
}

/** Persist and enqueue a bot routine that wakes in the originating thread. */
export async function createScheduleFromTool(
  deps: ScheduleToolDeps,
  input: {
    workspaceId: string;
    botId: string;
    userId: string;
    threadId: string;
    name: string;
    prompt: string;
    timezone?: string;
    schedule: Record<string, unknown>;
  },
) {
  const name = input.name.trim();
  const prompt = input.prompt.trim();
  if (!name) return { error: "name is required." };
  if (!prompt) return { error: "prompt is required." };

  const timezone = String(input.timezone ?? "UTC");
  const resolved = resolveScheduleTiming(input.schedule, timezone);
  if (!resolved.ok) return { error: resolved.error };

  const row = await deps.prisma.routine.create({
    data: {
      workspaceId: input.workspaceId,
      botId: input.botId,
      userId: input.userId,
      threadId: input.threadId,
      name,
      prompt,
      crons: [resolved.cron],
      timezone,
      notify: true,
      active: true,
      nextRunAt: resolved.nextRunAt,
    },
  });

  try {
    await deps.jobs.enqueue(routineWakeupJob(row.id, resolved.nextRunAt));
  } catch {
    try {
      await deps.prisma.routine.delete({ where: { id: row.id } });
    } catch {
      // Do not soft-return while the row may still be active.
      await deps.prisma.routine.update({
        where: { id: row.id },
        data: { active: false, nextRunAt: null },
      });
    }
    return { error: "Could not schedule the reminder. Try again." };
  }

  try {
    await deps.events.append({
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      botId: input.botId,
      type: "routine.created",
      payload: { name: row.name },
    });
  } catch {
    // Match routines.create: the reminder is live even if the thread signal fails.
  }

  return {
    ok: true as const,
    routineId: row.id,
    name: row.name,
    cron: row.crons[0],
    nextRunAt: row.nextRunAt?.toISOString() ?? null,
    oneShot: resolved.oneShot,
  };
}

/** List bot routines, optionally restricted to the current group thread. */
export async function listSchedulesFromTool(
  deps: Pick<ScheduleToolDeps, "prisma">,
  input: { workspaceId: string; botId: string; userId: string; threadId?: string },
) {
  const rows = await deps.prisma.routine.findMany({
    where: {
      workspaceId: input.workspaceId,
      botId: input.botId,
      userId: input.userId,
      ...(input.threadId ? { threadId: input.threadId } : {}),
    },
    orderBy: { createdAt: "desc" },
  });
  return {
    routines: rows.map((row) => ({
      routineId: row.id,
      name: row.name,
      prompt: row.prompt,
      crons: row.crons,
      active: row.active,
      nextRunAt: row.nextRunAt?.toISOString() ?? null,
      oneShot: isOneShotRoutineCrons(row.crons),
    })),
  };
}

/** Cancel a bot routine, optionally restricted to the current group thread. */
export async function cancelScheduleFromTool(
  deps: ScheduleToolDeps,
  input: {
    workspaceId: string;
    botId: string;
    userId: string;
    threadId?: string;
    routineId?: string;
    name?: string;
  },
) {
  const routineId = input.routineId?.trim();
  const name = input.name?.trim();
  if (!routineId && !name) {
    return { error: "Provide routineId or the exact schedule name to cancel." };
  }

  const existing = await deps.prisma.routine.findFirst({
    where: {
      workspaceId: input.workspaceId,
      botId: input.botId,
      userId: input.userId,
      ...(input.threadId ? { threadId: input.threadId } : {}),
      ...(routineId ? { id: routineId } : { name: name! }),
    },
  });
  if (!existing) return { error: "Schedule not found." };

  await deps.prisma.routine.delete({ where: { id: existing.id } });
  await deps.jobs.cancel(routineJobKey(existing.id));
  return { ok: true as const, routineId: existing.id, name: existing.name };
}
