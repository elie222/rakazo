import type { ConnectorProvider, JobPublisher } from "@rakazo/adapter-kit";
import { routineJobKey, routineWakeupJob } from "@rakazo/adapter-kit";
import type { RoutineWatch } from "@rakazo/contracts";
import { RoutineWatchSchema, TimeZoneSchema } from "@rakazo/contracts";
import {
  cronFromPreset,
  formatCron,
  isOneShotRoutineCron,
  isOneShotRoutineCrons,
  nextCronDate,
  nextCronDateAcross,
  ONCE_ROUTINE_CRON,
  unevenInterval,
  wallClock,
  zonedDateTime,
} from "@rakazo/core";
import type { Prisma, PrismaClient, ThreadEvents } from "@rakazo/db";
import { runAsSystemInTransaction } from "@rakazo/db";

import { localDateTime } from "./current-time.js";
import { validateRoutineWatch } from "./routine-watch.js";

export { isOneShotRoutineCron, ONCE_ROUTINE_CRON };

export const SCHEDULE_TOOL_NAMES = new Set([
  "schedule_create",
  "schedule_list",
  "schedule_update",
  "schedule_cancel",
]);

/** Routine runs may create, list, or cancel routines, but may not update them. */
const ROUTINE_RUN_HIDDEN_TOOLS = new Set(["schedule_update"]);

export function filterBuiltinToolsForRun<T extends { name: string }>(
  tools: T[],
  runTrigger: string,
): T[] {
  return runTrigger === "routine"
    ? tools.filter((tool) => !ROUTINE_RUN_HIDDEN_TOOLS.has(tool.name))
    : tools;
}

/** Keep cross-bot messaging thread-specific while exposing schedules in DMs and groups. */
export function filterBuiltinToolsForThread<T extends { name: string }>(
  tools: T[],
  groupId: string | null | undefined,
): T[] {
  return tools.filter(
    (tool) =>
      // In a group the room is the shared surface: hand the stage to a member
      // rather than starting a private thread off to one side.
      !groupId || tool.name !== "message_bot",
  );
}

type ScheduleUnit = "minutes" | "hours" | "days" | "seconds";

export type ResolvedSchedule =
  | { ok: true; cron: string; nextRunAt: Date; oneShot: boolean }
  | { ok: false; error: string };

/**
 * Providers sometimes serialize omitted optional tool fields as null or an empty
 * string. Treat those values as absent, while preserving numeric zero so the
 * normal validation can reject an invalid zero interval/delay with a useful
 * error instead of reporting two schedule modes at once.
 */
export function isScheduleValueProvided(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  return typeof value !== "string" || value.trim().length > 0;
}

export function compactScheduleInput(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => isScheduleValueProvided(value)),
  );
}

export function resolveScheduleTiming(
  input: {
    cron?: unknown;
    every?: unknown;
    unit?: unknown;
    runAt?: unknown;
    delayMinutes?: unknown;
    delaySeconds?: unknown;
    startAt?: unknown;
  },
  timezone = "UTC",
): ResolvedSchedule {
  const hasRepeat =
    isScheduleValueProvided(input.cron) ||
    isScheduleValueProvided(input.every) ||
    isScheduleValueProvided(input.unit);
  const hasOneShot =
    isScheduleValueProvided(input.runAt) ||
    isScheduleValueProvided(input.delayMinutes) ||
    isScheduleValueProvided(input.delaySeconds);
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
  const hasCron = isScheduleValueProvided(input.cron);
  const hasInterval = isScheduleValueProvided(input.every) || isScheduleValueProvided(input.unit);
  if (hasCron && hasInterval) {
    return {
      ok: false,
      error: "Provide exactly one timing method: cron, or every and unit, not both.",
    };
  }

  if (hasOneShot && isScheduleValueProvided(input.startAt)) {
    return { ok: false, error: "startAt is only for repeating schedules." };
  }

  if (hasOneShot) {
    const oneShotFields = [input.runAt, input.delayMinutes, input.delaySeconds].filter(
      isScheduleValueProvided,
    );
    if (oneShotFields.length !== 1) {
      return {
        ok: false,
        error:
          "Provide exactly one of runAt, delayMinutes, or delaySeconds for a one-shot schedule.",
      };
    }
    let nextRunAt: Date;
    if (isScheduleValueProvided(input.delaySeconds)) {
      const delaySeconds = Number(input.delaySeconds);
      if (!Number.isFinite(delaySeconds) || delaySeconds < 0) {
        return { ok: false, error: "delaySeconds must be a non-negative number." };
      }
      nextRunAt = new Date(Date.now() + delaySeconds * 1_000);
    } else if (isScheduleValueProvided(input.delayMinutes)) {
      const delayMinutes = Number(input.delayMinutes);
      if (!Number.isFinite(delayMinutes) || delayMinutes < 0) {
        return { ok: false, error: "delayMinutes must be a non-negative number." };
      }
      nextRunAt = new Date(Date.now() + delayMinutes * 60_000);
    } else {
      const parsed = zonedDateTime(String(input.runAt), timezone);
      if (!parsed) return { ok: false, error: "runAt must be a valid ISO datetime." };
      nextRunAt = parsed;
    }
    if (nextRunAt.getTime() <= Date.now()) {
      return { ok: false, error: `One-shot schedules must run in the future. ${nowIn(timezone)}` };
    }
    return { ok: true, cron: ONCE_ROUTINE_CRON, nextRunAt, oneShot: true };
  }

  // The first run is the first occurrence at or after startAt.
  let from = new Date();
  if (isScheduleValueProvided(input.startAt)) {
    const startAt = zonedDateTime(String(input.startAt), timezone);
    if (!startAt) return { ok: false, error: "startAt must be an ISO date or datetime." };
    if (startAt.getTime() < Date.now()) {
      return {
        ok: false,
        error: `startAt is in the past; omit it to start now. ${nowIn(timezone)}`,
      };
    }
    from = new Date(startAt.getTime() - 1);
  }

  if (hasCron) {
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
      const nextRunAt = nextCronDate(cron, from, timezone);
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
    const nextRunAt = nextCronDate(cron, from, timezone);
    return { ok: true, cron, nextRunAt, oneShot: false };
  } catch {
    return { ok: false, error: "every/unit produced an invalid cron expression." };
  }
}

function nowIn(timezone: string): string {
  const now = new Date();
  return `It is now ${localDateTime(now, timezone) ?? now.toISOString()} in ${timezone}.`;
}

/** The stored timing as the bot should report it: in the routine's timezone, with the next run. */
export function describeRoutineTiming(row: {
  crons: string[];
  timezone: string;
  nextRunAt: Date | null;
}) {
  return {
    timezone: row.timezone,
    ...(row.crons.length ? { schedule: row.crons.map((cron) => formatCron(cron)).join("; ") } : {}),
    nextRun: row.nextRunAt
      ? (localDateTime(row.nextRunAt, row.timezone) ?? row.nextRunAt.toISOString())
      : null,
  };
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
  connector?: ConnectorProvider;
  prisma: PrismaClient;
  events: ThreadEvents;
  jobs: JobPublisher;
}

/** The user's saved timezone, so "every morning at 9" means their 9, not UTC's. */
export async function userTimeZone(prisma: PrismaClient, userId: string): Promise<string> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { timezone: true } });
  const timezone = user?.timezone;
  return timezone && TimeZoneSchema.safeParse(timezone).success ? timezone : "UTC";
}

/**
 * Save the account timezone and move the routines that took it: every routine of the user
 * whose zone is the previous account zone keeps its local schedule in the new one, exactly
 * as a schedule_update zone change keeps it. A routine pinned to another zone stays, and so
 * does one stored while the account had no zone, which may be pinned to UTC on purpose.
 * Clearing the zone (`null`) only clears the account: a routine cannot hold no zone.
 * `timezone` is the already-validated zone the caller wants saved.
 */
export async function changeUserTimezone(
  deps: Pick<ScheduleToolDeps, "prisma" | "jobs">,
  userId: string,
  timezone: string | null,
): Promise<void> {
  const woken: { id: string; nextRunAt: Date }[] = [];
  await deps.prisma.$transaction(async (tx) => {
    // The user's routines sit in every space they own one in, and a tenant scope only
    // sees its own space's rows, so the move runs as an explicit cross-space bypass.
    await runAsSystemInTransaction(tx, "move the user's routines in all their spaces", async () => {
      // The lock serializes overlapping zone saves: each reads the previous zone only
      // after the last save committed, so no routine keeps an intermediate zone.
      await tx.$queryRaw`SELECT id FROM "user" WHERE id = ${userId} FOR UPDATE`;
      const user = await tx.user.findUnique({ where: { id: userId }, select: { timezone: true } });
      if (!user || user.timezone === timezone) return;
      await tx.user.update({ where: { id: userId }, data: { timezone } });
      if (!timezone || !user.timezone) return;
      // Lock the rows about to move, so a run firing meanwhile cannot advance one between
      // the read and the write: its claim lands after the commit and re-derives from the
      // moved schedule.
      await tx.$queryRaw`SELECT id FROM "routines" WHERE "userId" = ${userId} AND timezone = ${user.timezone} FOR UPDATE`;
      const routines = await tx.routine.findMany({ where: { userId, timezone: user.timezone } });
      for (const routine of routines) {
        const nextRunAt = nextRunAtAfterTimezoneMove(routine, timezone);
        const movedNext = nextRunAt?.getTime() !== routine.nextRunAt?.getTime();
        // The zone and the timing it was computed from are part of the write, so a change
        // that slipped through anyway keeps its advance and the routine its old zone.
        const { count } = await tx.routine.updateMany({
          where: {
            id: routine.id,
            userId,
            timezone: user.timezone,
            ...(movedNext ? { nextRunAt: routine.nextRunAt } : {}),
          },
          data: { timezone, ...(movedNext ? { nextRunAt } : {}) },
        });
        if (count === 1 && movedNext && routine.active && nextRunAt) {
          woken.push({ id: routine.id, nextRunAt });
        }
      }
    });
  });
  // Enqueue after the commit, like every routine write; the reconciler repairs a miss.
  for (const routine of woken) {
    await deps.jobs.enqueue(routineWakeupJob(routine.id, routine.nextRunAt));
  }
}

/**
 * The next run after a routine's zone moves with the account: an active repeat keeps its
 * local time in the new zone. Anything else keeps its pending instant — a one-shot is an
 * absolute time, a watch checks on its own interval, and a row with no crons has nothing
 * to retime.
 */
function nextRunAtAfterTimezoneMove(
  routine: {
    crons: string[];
    timezone: string;
    nextRunAt: Date | null;
    active: boolean;
    watch: unknown;
  },
  timezone: string,
): Date | null {
  if (
    !routine.active ||
    routine.watch != null ||
    isOneShotRoutineCrons(routine.crons) ||
    routine.crons.length === 0
  ) {
    return routine.nextRunAt;
  }
  const due = routine.nextRunAt;
  if (routine.crons.length === 1) {
    let timing: Record<string, unknown> = { cron: routine.crons[0] };
    if (due && due.getTime() > Date.now()) {
      const moved = carriedRunAtForTimezone(
        routine.crons[0] ?? "",
        due,
        routine.timezone,
        timezone,
      );
      if (moved.carried) return moved.carried;
      if (moved.startAt) timing = { cron: routine.crons[0], startAt: moved.startAt };
    }
    const resolved = resolveScheduleTiming(timing, timezone);
    return resolved.ok ? resolved.nextRunAt : routine.nextRunAt;
  }
  // Several crons keep plain cron matches (their interval anchors are unknown), so the
  // pending occurrence's local time is carried the same way; a zone behind restarts from
  // when it was due, so no occurrence is skipped.
  if (due && due.getTime() > Date.now()) {
    const local = zonedDateTime(wallClock(due, routine.timezone), timezone);
    if (local && local.getTime() <= due.getTime()) {
      if (local.getTime() > Date.now()) return local;
      return nextCronDateAcross(routine.crons, new Date(), timezone) ?? routine.nextRunAt;
    }
    return (
      nextCronDateAcross(routine.crons, new Date(due.getTime() - 1), timezone) ?? routine.nextRunAt
    );
  }
  return nextCronDateAcross(routine.crons, new Date(), timezone) ?? routine.nextRunAt;
}

/** Each routine is an unattended model run, so a looping bot must not stack them. */
export const MAX_ACTIVE_ROUTINES_PER_BOT = 50;

/** Persist and enqueue a bot routine that wakes in the originating thread. */
export async function createScheduleFromTool(
  deps: ScheduleToolDeps,
  input: {
    spaceId: string;
    botId: string;
    userId: string;
    threadId: string;
    target?: { botId: string; threadId: string };
    name: string;
    prompt: string;
    timezone?: string;
    schedule: Record<string, unknown>;
  },
) {
  const routineBotId = input.target?.botId ?? input.botId;
  const routineThreadId = input.target?.threadId ?? input.threadId;
  const name = input.name.trim();
  const prompt = input.prompt.trim();
  if (!name) return { error: "name is required." };
  if (!prompt) return { error: "prompt is required." };

  const active = await deps.prisma.routine.findMany({
    where: { spaceId: input.spaceId, botId: routineBotId, active: true },
    select: { id: true, name: true, threadId: true },
  });
  // Match per thread: schedule_update in a group only reaches this thread's routines.
  const sameName = active.find(
    (row) =>
      row.threadId === routineThreadId && row.name.trim().toLowerCase() === name.toLowerCase(),
  );
  if (sameName) {
    return {
      error: `An active routine named "${sameName.name}" already exists (${sameName.id}). Update or cancel it instead.`,
    };
  }
  if (active.length >= MAX_ACTIVE_ROUTINES_PER_BOT) {
    return {
      error: `This bot already has ${MAX_ACTIVE_ROUTINES_PER_BOT} active routines. Cancel one before adding another.`,
    };
  }

  const parsedTimezone = TimeZoneSchema.safeParse(
    input.timezone ?? (await userTimeZone(deps.prisma, input.userId)),
  );
  if (!parsedTimezone.success) {
    return { error: parsedTimezone.error.issues.map((issue) => issue.message).join("; ") };
  }
  const timezone = parsedTimezone.data;
  if (input.schedule.watch !== undefined) {
    return createWatchFromTool(deps, { ...input, name, prompt, timezone });
  }
  const resolved = resolveScheduleTiming(input.schedule, timezone);
  if (!resolved.ok) return { error: resolved.error };

  const row = await deps.prisma.routine.create({
    data: {
      spaceId: input.spaceId,
      botId: routineBotId,
      userId: input.userId,
      threadId: routineThreadId,
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
      spaceId: input.spaceId,
      threadId: routineThreadId,
      botId: routineBotId,
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
    ...describeRoutineTiming(row),
  };
}

/** A routine that runs when something changes, from `schedule_create` with `watch`. */
async function createWatchFromTool(
  deps: ScheduleToolDeps,
  input: {
    spaceId: string;
    botId: string;
    userId: string;
    threadId: string;
    name: string;
    prompt: string;
    timezone: string;
    schedule: Record<string, unknown>;
  },
) {
  const others = Object.keys(input.schedule).filter((key) => key !== "watch");
  if (others.length) {
    return { error: "A watch checks on its own interval; do not combine it with a schedule." };
  }
  // Some models send the object as JSON text; take it either way.
  let raw = input.schedule.watch;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return { error: 'watch must be an object like {"kind":"files","paths":["inbox/"]}.' };
    }
  }
  const parsed = RoutineWatchSchema.safeParse(raw);
  if (!parsed.success) {
    return { error: parsed.error.issues.map((issue) => issue.message).join("; ") };
  }
  try {
    // Match routine editing's owner/space boundary before creating unattended work.
    const bot = await deps.prisma.bot.findFirst({
      where: { id: input.botId, spaceId: input.spaceId, userId: input.userId, archivedAt: null },
      include: { computer: true },
    });
    if (!bot) return { error: "Bot not found." };
    await validateRoutineWatch(deps, parsed.data, input, bot.computer);
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Invalid change trigger." };
  }
  const nextRunAt = new Date(Date.now() + 2_000);
  const row = await deps.prisma.routine.create({
    data: {
      spaceId: input.spaceId,
      botId: input.botId,
      userId: input.userId,
      threadId: input.threadId,
      name: input.name,
      prompt: input.prompt,
      crons: [],
      timezone: input.timezone,
      notify: true,
      active: true,
      watch: parsed.data as Prisma.InputJsonValue,
      nextRunAt,
    },
  });
  try {
    await deps.jobs.enqueue(routineWakeupJob(row.id, nextRunAt));
  } catch {
    await deps.prisma.routine
      .update({ where: { id: row.id }, data: { active: false, nextRunAt: null } })
      .catch(() => undefined);
    return { error: "Could not start the watch. Try again." };
  }
  try {
    await deps.events.append({
      spaceId: input.spaceId,
      threadId: input.threadId,
      botId: input.botId,
      type: "routine.created",
      payload: { name: row.name },
    });
  } catch {
    // The watch is live even if the thread signal fails.
  }
  return {
    ok: true as const,
    routineId: row.id,
    name: row.name,
    watch: parsed.data,
    note: `Takes a first reading now, then checks every ${parsed.data.everyMinutes} minutes and runs only when it changes.`,
  };
}

/** List bot routines, optionally restricted to the current group thread. */
export async function listSchedulesFromTool(
  deps: Pick<ScheduleToolDeps, "prisma">,
  input: { spaceId: string; botId: string; userId: string; threadId?: string },
) {
  const rows = await deps.prisma.routine.findMany({
    where: {
      spaceId: input.spaceId,
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
      ...describeRoutineTiming(row),
      ...(row.watch ? { watch: row.watch, lastCheck: row.watchState ?? null } : {}),
    })),
  };
}

const TIMING_FIELDS = ["cron", "every", "unit", "runAt", "delayMinutes", "delaySeconds"] as const;

/**
 * The pending occurrence a timezone move keeps. A new timezone alone keeps the next run's
 * local time, so a start set for later holds. In a timezone behind, the first run is the
 * first one from when it was due (`startAt` restarts it there), so none is skipped. An
 * uneven step recurs from its last run: by its fixed gap, which no timezone moves, or by
 * local days, so it keeps its local time either way.
 */
function carriedRunAtForTimezone(
  cron: string,
  due: Date,
  fromTimezone: string,
  toTimezone: string,
): { carried: Date | null; startAt?: string } {
  const local = zonedDateTime(wallClock(due, fromTimezone), toTimezone);
  const step = unevenInterval(cron);
  if (step && step.unit !== "days") return { carried: due };
  if (local && (step || local.getTime() <= due.getTime())) {
    return { carried: local.getTime() > Date.now() ? local : null };
  }
  return { carried: null, startAt: due.toISOString() };
}

/**
 * Edit one of this bot's routines in place: name, prompt, timing (with startAt), or active.
 * Scoped like cancel, so another bot's or another thread's routine reads as not found.
 */
export async function updateScheduleFromTool(
  deps: ScheduleToolDeps,
  input: {
    spaceId: string;
    botId: string;
    userId: string;
    /** The thread the change is announced in. */
    threadId: string;
    /** In a group, only that thread's routines. */
    scopeThreadId?: string;
    routineId: string;
    name?: string;
    prompt?: string;
    active?: boolean;
    timezone?: string;
    schedule: Record<string, unknown>;
  },
) {
  const routineId = input.routineId.trim();
  if (!routineId) return { error: "routineId is required." };
  const name = input.name?.trim();
  const prompt = input.prompt?.trim();
  if (input.name !== undefined && !name) return { error: "name cannot be empty." };
  if (input.prompt !== undefined && !prompt) return { error: "prompt cannot be empty." };

  const scope = {
    spaceId: input.spaceId,
    botId: input.botId,
    userId: input.userId,
    ...(input.scopeThreadId ? { threadId: input.scopeThreadId } : {}),
  };
  const existing = await deps.prisma.routine.findFirst({
    where: { ...scope, id: routineId, bot: { archivedAt: null } },
  });
  if (!existing) return { error: "Schedule not found." };

  let timezone = existing.timezone;
  if (input.timezone !== undefined) {
    const parsed = TimeZoneSchema.safeParse(input.timezone);
    if (!parsed.success) {
      return { error: parsed.error.issues.map((issue) => issue.message).join("; ") };
    }
    timezone = parsed.data;
  }
  const hasTiming = TIMING_FIELDS.some((field) => isScheduleValueProvided(input.schedule[field]));
  const retime =
    hasTiming || isScheduleValueProvided(input.schedule.startAt) || timezone !== existing.timezone;
  if (!retime && name === undefined && prompt === undefined && input.active === undefined) {
    return { error: "Nothing to update." };
  }
  if (retime && existing.watch != null) {
    return { error: "A watch checks on its own interval; cancel it and create a schedule." };
  }

  const active = input.active ?? existing.active;
  let crons = existing.crons;
  let nextRunAt = existing.nextRunAt;
  let carried: Date | null = null;
  const oneShot = isOneShotRoutineCrons(existing.crons);
  if (retime) {
    let timing = input.schedule;
    if (!hasTiming) {
      // startAt or a new timezone alone keeps the current repeat.
      if (existing.crons.length !== 1 || oneShot) {
        return {
          error: oneShot
            ? "Give runAt to move a one-time schedule."
            : "Give cron or every/unit along with startAt or timezone.",
        };
      }
      const cron = existing.crons[0] ?? "";
      timing = { ...input.schedule, cron };
      const due = existing.nextRunAt;
      if (!isScheduleValueProvided(input.schedule.startAt) && due && due.getTime() > Date.now()) {
        const moved = carriedRunAtForTimezone(cron, due, existing.timezone, timezone);
        carried = moved.carried;
        if (moved.startAt) timing = { ...timing, startAt: moved.startAt };
      }
    }
    const resolved = resolveScheduleTiming(timing, timezone);
    if (!resolved.ok) return { error: resolved.error };
    crons = [resolved.cron];
    nextRunAt = carried ?? resolved.nextRunAt;
  } else if (active && !(existing.active && existing.nextRunAt)) {
    // Resuming: a watch checks right away, a repeat picks its next occurrence from now.
    if (existing.watch != null) nextRunAt = new Date(Date.now() + 2_000);
    else if (oneShot) {
      if (!existing.nextRunAt || existing.nextRunAt.getTime() <= Date.now()) {
        return { error: "This one-time schedule has no time left; give a new runAt." };
      }
    } else nextRunAt = nextCronDateAcross(crons, new Date(), timezone);
  }
  if (!active) nextRunAt = null;
  const timingChanged =
    retime || active !== existing.active || nextRunAt?.getTime() !== existing.nextRunAt?.getTime();

  // The scope is part of the write, so the routine cannot change hands between the read and it.
  // A name or prompt edit writes only those fields, so a run claimed meanwhile keeps its advance;
  // a timing edit applies only if no run advanced the routine since the read.
  const { count } = await deps.prisma.routine.updateMany({
    where: {
      ...scope,
      id: existing.id,
      bot: { archivedAt: null },
      ...(timingChanged ? { active: existing.active, nextRunAt: existing.nextRunAt } : {}),
    },
    data: {
      ...(name === undefined ? {} : { name }),
      ...(prompt === undefined ? {} : { prompt }),
      ...(timingChanged ? { crons, timezone, active, nextRunAt } : {}),
    },
  });
  if (count === 0) {
    return {
      error: timingChanged
        ? "The schedule changed while saving. Call schedule_list and try again."
        : "Schedule not found.",
    };
  }

  if (timingChanged) {
    if (active && nextRunAt) await deps.jobs.enqueue(routineWakeupJob(existing.id, nextRunAt));
    else if (existing.active) await deps.jobs.cancel(routineJobKey(existing.id));
  }

  try {
    await deps.events.append({
      spaceId: input.spaceId,
      threadId: existing.threadId ?? input.threadId,
      botId: input.botId,
      type: "routine.updated",
      payload: { routineId: existing.id, active },
    });
  } catch {
    // The change is saved even if the thread signal fails.
  }

  return {
    ok: true as const,
    routineId: existing.id,
    name: name ?? existing.name,
    prompt: prompt ?? existing.prompt,
    active,
    crons,
    nextRunAt: nextRunAt?.toISOString() ?? null,
    oneShot: isOneShotRoutineCrons(crons),
    ...describeRoutineTiming({ crons, timezone, nextRunAt }),
  };
}

/** Cancel a bot routine, optionally restricted to the current group thread. */
export async function cancelScheduleFromTool(
  deps: ScheduleToolDeps,
  input: {
    spaceId: string;
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

  const scope = {
    spaceId: input.spaceId,
    botId: input.botId,
    userId: input.userId,
    ...(input.threadId ? { threadId: input.threadId } : {}),
  };
  const existing = await deps.prisma.routine.findFirst({
    where: { ...scope, ...(routineId ? { id: routineId } : { name: name! }) },
  });
  if (!existing) return { error: "Schedule not found." };

  // The scope is part of the delete, so the routine cannot change hands between the read and it.
  const { count } = await deps.prisma.routine.deleteMany({ where: { ...scope, id: existing.id } });
  if (count === 0) return { error: "Schedule not found." };
  await deps.jobs.cancel(routineJobKey(existing.id));
  return { ok: true as const, routineId: existing.id, name: existing.name };
}

/** The watch a `schedule_create` call asks for, including JSON tool input. */
export function watchFromTool(value: unknown): RoutineWatch | undefined {
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  const parsed = RoutineWatchSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** Creating unattended shell work requires explicit approval, including JSON tool input. */
export function commandWatchFromTool(value: unknown): string | undefined {
  const watch = watchFromTool(value);
  return watch?.kind === "command" ? watch.command : undefined;
}
