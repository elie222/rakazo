import { ORPCError } from "@orpc/server";
import { routineWakeupJob } from "@rakazo/adapter-kit";
import type { OwnerComputerRefusal } from "@rakazo/adapters";
import {
  botEventRoutines,
  firstWatchCheck,
  listAgentSkillRecords,
  ownerComputerRefusal,
  parseRoutineWatch,
  parseRoutineWatchState,
  routineComputerFingerprint,
  routineGroupThreadId,
  routineRunModelPin,
} from "@rakazo/adapters";
import type { Actor, CreateRoutineInput, Routine } from "@rakazo/contracts";
import { canonicalPiProviderId, RoutineEmailSendersSchema } from "@rakazo/contracts";
import {
  ClientError,
  displayName,
  hasMixedOneShotSchedule,
  isOneShotRoutineCrons,
  nextCronDateAcrossStrict,
  routineScheduleDelayed,
} from "@rakazo/core";
import type { Prisma, PrismaClient } from "@rakazo/db";
import { IsolationError } from "@rakazo/db";
import type { RouterDeps } from "../router.js";
import type { RouterContext } from "../routes/context.js";

export function assertRoutineSchedule(input: CreateRoutineInput): void {
  if (hasMixedOneShotSchedule(input.crons)) {
    throw new ORPCError("BAD_REQUEST", {
      message: "A one-time schedule can't be combined with other schedules.",
    });
  }
  if (input.active && isOneShotRoutineCrons(input.crons)) {
    throw new ORPCError("BAD_REQUEST", {
      message: "One-shot schedules must be created from chat.",
    });
  }
}

export function routineNextRunAt(input: CreateRoutineInput): Date | null {
  // Validate every recurring cron even when inactive; @once and webhook-only have no next date.
  let nextRunAt: Date | null = null;
  if (input.crons.length > 0 && !isOneShotRoutineCrons(input.crons)) {
    const computedNextRunAt = nextRoutineDate(input.crons, input.timezone);
    nextRunAt = input.active ? computedNextRunAt : null;
  }
  // A change trigger takes its first reading right away; that reading is the baseline.
  if (input.watch && input.active) nextRunAt = firstWatchCheck();
  return nextRunAt;
}

export function routineRowData(actor: Actor, input: CreateRoutineInput, nextRunAt: Date | null) {
  return {
    spaceId: actor.spaceId,
    botId: input.botId,
    userId: actor.userId,
    name: input.name,
    prompt: input.prompt,
    crons: input.crons,
    timezone: input.timezone,
    notify: input.notify,
    // What a watch read is not the owner's words, so it never runs as a turn in the chat.
    inChat: input.inChat && !input.watch,
    active: input.active,
    webhookEnabled: input.webhookEnabled,
    githubEnabled: input.githubEnabled,
    messageProvider: input.messageProvider,
    emailSenders: input.emailSenders,
    modelProvider: input.modelProvider,
    modelId: input.modelId,
    thinkingLevel: input.thinkingLevel,
    ...(input.watch ? { watch: input.watch as Prisma.InputJsonValue } : {}),
    nextRunAt,
  };
}

export function nextRoutineDate(crons: string[], timezone: string): Date {
  let next: Date | null;
  try {
    next = nextCronDateAcrossStrict(crons, new Date(), timezone);
  } catch {
    // Parsing the caller's expressions is all this does, so any failure is a malformed one.
    throw new ClientError("BAD_REQUEST", "Enter a valid cron expression.");
  }
  if (!next) throw new ORPCError("BAD_REQUEST", { message: "Enter a valid cron expression." });
  return next;
}

export function mapRoutine(row: {
  id: string;
  botId: string;
  name: string;
  prompt: string;
  crons: string[];
  timezone: string;
  active: boolean;
  notify: boolean;
  inChat: boolean;
  webhookEnabled: boolean;
  githubEnabled: boolean;
  messageProvider: string | null;
  emailSenders: string | null;
  modelProvider: string | null;
  modelId: string | null;
  thinkingLevel: string | null;
  watch: unknown;
  watchState: unknown;
  lastRunAt: Date | null;
  nextRunAt: Date | null;
  createdAt: Date;
}): Routine {
  return {
    id: row.id,
    botId: row.botId,
    name: row.name,
    prompt: row.prompt,
    crons: row.crons,
    timezone: row.timezone,
    active: row.active,
    notify: row.notify,
    inChat: row.inChat,
    webhookEnabled: row.webhookEnabled,
    githubEnabled: row.githubEnabled,
    messageProvider: row.messageProvider,
    emailSenders: RoutineEmailSendersSchema.safeParse(row.emailSenders).data ?? null,
    modelProvider: row.modelProvider ? canonicalPiProviderId(row.modelProvider) : null,
    modelId: row.modelId ?? null,
    thinkingLevel: (row.thinkingLevel as Routine["thinkingLevel"]) ?? null,
    watch: parseRoutineWatch(row.watch),
    watchState: parseRoutineWatchState(row.watchState),
    lastRunAt: row.lastRunAt?.toISOString() ?? null,
    nextRunAt: row.nextRunAt?.toISOString() ?? null,
    scheduleDelayed: routineScheduleDelayed({
      active: row.active,
      nextRunAt: row.nextRunAt?.getTime() ?? null,
    }),
    createdAt: row.createdAt.toISOString(),
  };
}

type RoutineRow = Parameters<typeof mapRoutine>[0] & {
  userId: string;
  threadId: string | null;
  computerPromptHash: string | null;
};

type RoutineViewDeps = Pick<RouterDeps, "prisma" | "userDevices">;

/** Refusals the owner can't undo in the routine's editor, so the switch is left out. */
const SWITCH_HIDDEN: ReadonlySet<OwnerComputerRefusal> = new Set([
  "other_owner",
  "group",
  "event_routines",
]);

/**
 * "Use my computer" for each routine the viewer may switch it on for, while they have a computer
 * paired (see ownerComputerRefusal). It shows on only while a run would still get the computer.
 */
async function computerSwitches(
  deps: RoutineViewDeps,
  actor: Actor,
  rows: RoutineRow[],
): Promise<Map<string, boolean>> {
  const own = rows.filter((row) => row.userId === actor.userId);
  if (own.length === 0 || !deps.userDevices) return new Map();
  const botIds = [...new Set(own.map((row) => row.botId))];
  const threadIds = [...new Set(own.flatMap((row) => (row.threadId ? [row.threadId] : [])))];
  const [bots, eventRoutines, groupThreads, pairedSince] = await Promise.all([
    deps.prisma.bot.findMany({ where: { id: { in: botIds } }, select: { id: true, userId: true } }),
    deps.prisma.routine.findMany({ where: botEventRoutines(botIds), select: { botId: true } }),
    deps.prisma.thread.findMany({
      where: { id: { in: threadIds }, groupId: { not: null } },
      select: { id: true },
    }),
    deps.userDevices.pairedSince(actor.userId),
  ]);
  if (!pairedSince) return new Map();
  const botOwners = new Map(bots.map((bot) => [bot.id, bot.userId]));
  const eventBots = new Set(eventRoutines.map((routine) => routine.botId));
  const groups = new Set(groupThreads.map((thread) => thread.id));
  const skills = own.some((row) => row.computerPromptHash)
    ? await listAgentSkillRecords(deps.prisma, actor)
    : [];
  const switches = new Map<string, boolean>();
  for (const row of own) {
    const refused = ownerComputerRefusal({
      ownerId: actor.userId,
      userId: row.userId,
      botUserId: botOwners.get(row.botId) ?? "",
      inChat: row.inChat,
      watch: row.watch,
      groupThread: row.threadId !== null && groups.has(row.threadId),
      botEventRoutines: eventBots.has(row.botId),
      approved: row.computerPromptHash,
      current: routineComputerFingerprint(row.prompt, skills),
    });
    if (refused && SWITCH_HIDDEN.has(refused)) continue;
    switches.set(row.id, Boolean(row.computerPromptHash) && refused === null);
  }
  return switches;
}

/**
 * The routines as a member of the Space sees them, each with whose accounts it runs with: the
 * owner's display name and whether that is the viewer, never their id or email.
 */
export async function routineViews(
  deps: RoutineViewDeps,
  actor: Actor,
  rows: RoutineRow[],
): Promise<Routine[]> {
  if (rows.length === 0) return [];
  const { prisma } = deps;
  const computer = await computerSwitches(deps, actor, rows);
  const owners = await prisma.spaceMember.findMany({
    where: { spaceId: actor.spaceId, userId: { in: [...new Set(rows.map((row) => row.userId))] } },
    select: {
      userId: true,
      member: { select: { user: { select: { name: true, email: true } } } },
    },
  });
  // A name that holds its account's email address would show that address to the whole Space.
  const names = new Map(
    owners.map(({ userId, member: { user } }) => [
      userId,
      user.name.toLowerCase().includes(user.email.toLowerCase()) ? "" : user.name,
    ]),
  );
  return rows.map((row) => {
    const name = names.get(row.userId);
    return {
      ...mapRoutine(row),
      editable: row.userId === actor.userId,
      runsAs:
        name === undefined
          ? null
          : { name: displayName(name, "Member"), isViewer: row.userId === actor.userId },
      ...(computer.has(row.id) ? { useComputer: computer.get(row.id) } : {}),
    };
  });
}

/** One routine as `routineViews` shows it, for the one a member just created or changed. */
export async function routineView(
  deps: RoutineViewDeps,
  actor: Actor,
  row: RoutineRow,
): Promise<Routine> {
  const [view] = await routineViews(deps, actor, [row]);
  if (!view) throw new IsolationError();
  return view;
}

/** Only a routine's owner changes it; other members may turn it on or off (see routines.update). */
export async function listRoutinesDto(deps: RouterDeps, actor: Actor, botId: string) {
  const rows = await deps.prisma.routine.findMany({
    where: { botId, spaceId: actor.spaceId },
  });
  return routineViews(deps, actor, rows);
}

export function createRoutineAnnouncer(deps: RouterDeps) {
  const announceRoutine = async (
    actor: Actor,
    bot: { id: string; thread: { id: string } | null },
    row: Awaited<ReturnType<typeof deps.prisma.routine.create>>,
  ) => {
    if (bot.thread) {
      await deps.events.append({
        spaceId: actor.spaceId,
        threadId: bot.thread.id,
        botId: bot.id,
        type: "routine.created",
        payload: { name: row.name },
      });
    }
    if (row.active && row.nextRunAt) {
      await deps.jobs.enqueue(routineWakeupJob(row.id, row.nextRunAt));
    }
  };
  return announceRoutine;
}

/** A routine in the caller's Space on a bot they may use, the check behind every routine test run. */
export async function routineTestTarget(
  prisma: PrismaClient,
  repos: RouterContext["repos"],
  actor: Actor,
  routineId: string,
) {
  const routine = await prisma.routine.findFirst({
    where: { id: routineId, spaceId: actor.spaceId },
  });
  if (!routine) throw new IsolationError();
  const bot = await repos.getBot(actor, routine.botId);
  if (!bot.thread) throw new IsolationError();
  return { routine, botId: bot.id, threadId: bot.thread.id };
}

/**
 * Run now: the same chat a scheduled tick would use, so a routine made in a group chat runs there.
 * Spaces share their groups, so a member who may run the routine may see its group.
 */
export async function routineRunNowTarget(
  prisma: PrismaClient,
  repos: RouterContext["repos"],
  actor: Actor,
  routineId: string,
) {
  const target = await routineTestTarget(prisma, repos, actor, routineId);
  const groupThreadId = await routineGroupThreadId(prisma, target.routine, target.botId);
  return groupThreadId ? { ...target, threadId: groupThreadId } : target;
}

/**
 * The run key of a test run. The caller's id keeps another member from ever taking it, and the
 * previous release wrote `routine-test:<client nonce>` as given, so it can never write this prefix.
 */
export function routineTestRunNonce(actor: Actor, clientNonce: string): string {
  return `routine-run:${actor.userId}:${clientNonce}`;
}

/** A test run and the group chat it went to, null when it ran in the bot's own chat. */
const testRunSelect = { id: true, thread: { select: { groupId: true } } } as const;

/**
 * The run a nonce already created. The database keeps a nonce unique across the Space, so the
 * lookup is never narrowed to a thread: a retry must find the original run even after its group
 * was archived and the target moved to the bot's chat.
 */
export async function findRoutineTestRun(
  db: Pick<PrismaClient, "run">,
  actor: Actor,
  routineId: string,
  nonce: string | undefined,
) {
  if (!nonce) return null;
  return db.run.findFirst({
    where: {
      spaceId: actor.spaceId,
      userId: actor.userId,
      routineId,
      clientNonce: nonce,
    },
    select: testRunSelect,
  });
}

/** Task + run commit together; a run already saved under the nonce fails the insert. */
export async function createRoutineTestRun(
  tx: Prisma.TransactionClient,
  actor: Actor,
  target: Awaited<ReturnType<typeof routineTestTarget>>,
  prompt: string,
  nonce: string | undefined,
) {
  const { routine, botId, threadId } = target;
  const task = await tx.task.create({
    data: {
      spaceId: actor.spaceId,
      botId,
      threadId,
      userId: actor.userId,
      prompt,
      status: "queued",
    },
  });
  const currentModel = await tx.routine.findUnique({
    where: { id: routine.id },
    select: { modelProvider: true, modelId: true, thinkingLevel: true },
  });
  if (!currentModel) throw new IsolationError();
  return tx.run.create({
    data: {
      spaceId: actor.spaceId,
      botId,
      threadId,
      taskId: task.id,
      userId: actor.userId,
      status: "queued",
      trigger: "routine",
      routineId: routine.id,
      ...routineRunModelPin(currentModel),
      clientNonce: nonce,
    },
    select: { ...testRunSelect, status: true },
  });
}
