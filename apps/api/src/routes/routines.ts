import { ORPCError } from "@orpc/server";
import { routineJobKey, routineWakeupJob } from "@rakazo/adapter-kit";
import {
  botEventRoutines,
  firstWatchCheck,
  hasRoutineEvents,
  listAgentSkillRecords,
  lockOwnerComputerApproval,
  ownerComputerRefusal,
  parseRoutineWatch,
  postRoutineNotice,
  RoutineWatchError,
  routineComputerFingerprint,
  routineEditChange,
  routineEdited,
  routineEndError,
  routineEnded,
  routineEndInZone,
  runBeforeEnd,
  stableStringify,
  validateRoutineWatch,
  wakeRun,
} from "@rakazo/adapters";
import type { Actor, RoutineWatch } from "@rakazo/contracts";
import { canonicalPiProviderId, ROUTINE_TRIGGER_REQUIRED } from "@rakazo/contracts";
import {
  ClientError,
  expandSkillReferencesInPrompt,
  hasMixedOneShotSchedule,
  isOneShotRoutineCrons,
} from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { IsolationError, isRecordNotFound, Prisma } from "@rakazo/db";
import { assertRoutineModel } from "../bots/model-pins.js";
import { assertEmailTrigger } from "../email/bot-email-address.js";
import { listRoutineRuns } from "../routines/routine-runs.js";
import {
  assertRoutineSchedule,
  createRoutineTestRun,
  findRoutineTestRun,
  listRoutinesDto,
  nextRoutineDate,
  routineNextRunAt,
  routineRowData,
  routineRunNowTarget,
  routineTestRunNonce,
  routineView,
  routineViews,
} from "../routines/routines.js";
import type { RouterContext } from "./context.js";

/** A watch the caller wrote that cannot be checked is theirs to fix; anything else is a fault. */
async function assertRoutineWatch(
  watch: RoutineWatch,
  actor: Actor,
  bot: { id: string; computer?: { scope: string } | null },
): Promise<void> {
  await validateRoutineWatch({}, watch, { ...actor, botId: bot.id }, bot.computer).catch(
    (error: unknown) => {
      if (error instanceof RoutineWatchError) throw new ClientError("BAD_REQUEST", error.message);
      throw error;
    },
  );
}

export function routinesRoutes(ctx: RouterContext) {
  const { deps, repos, announceRoutine, codexCatalog, agentSkills, authed } = ctx;

  /**
   * "Use my computer" on: the fingerprint of the prompt the owner's editor showed, which this same
   * update stores, while they have a computer paired and the routine may use it (see
   * ownerComputerRefusal).
   */
  async function approveComputerPrompt(routine: {
    id: string;
    spaceId: string;
    userId: string;
    botId: string;
    botUserId: string;
    threadId: string | null;
    prompt: string | undefined;
    inChat: boolean;
    watch: RoutineWatch | null;
    eventTriggered: boolean;
  }): Promise<string> {
    const { prompt } = routine;
    if (prompt === undefined || !(await deps.userDevices?.pairedSince(routine.userId))) {
      throw new ClientError("BAD_REQUEST", "This routine can't use your computer.");
    }
    const [otherEventRoutines, thread, skills] = await Promise.all([
      deps.prisma.routine.count({
        where: { ...botEventRoutines([routine.botId]), id: { not: routine.id } },
      }),
      routine.threadId
        ? deps.prisma.thread.findUnique({
            where: { id: routine.threadId },
            select: { groupId: true },
          })
        : null,
      listAgentSkillRecords(deps.prisma, routine),
    ]);
    const fingerprint = routineComputerFingerprint(prompt, skills);
    const refused = ownerComputerRefusal({
      ownerId: routine.userId,
      userId: routine.userId,
      botUserId: routine.botUserId,
      inChat: routine.inChat,
      watch: routine.watch,
      groupThread: Boolean(thread?.groupId),
      botEventRoutines: routine.eventTriggered || otherEventRoutines > 0,
      current: fingerprint,
    });
    if (refused === "event_routines") {
      throw new ClientError(
        "BAD_REQUEST",
        "A bot with webhook, email, git or chat app triggers can't use your computer.",
      );
    }
    if (refused === "text_changed") {
      throw new ClientError("BAD_REQUEST", "A routine that uses a skill can't use your computer.");
    }
    if (refused || !fingerprint) {
      throw new ClientError("BAD_REQUEST", "This routine can't use your computer.");
    }
    return fingerprint;
  }

  return {
    routines: {
      listForMentions: authed.routines.listForMentions.handler(async ({ context, input }) => {
        const { actor } = context;
        // Same ownership predicates as getBot, so a batch never widens what routines/list allows.
        const bots = await deps.prisma.bot.findMany({
          where: {
            id: { in: input.botIds },
            spaceId: actor.spaceId,
            archivedAt: null,
          },
          select: { id: true },
        });
        const rows = await deps.prisma.routine.findMany({
          where: { botId: { in: bots.map((bot) => bot.id) }, spaceId: actor.spaceId },
        });
        const views = await routineViews(deps, actor, rows);
        return bots.map((bot) => ({
          botId: bot.id,
          routines: views.filter((routine) => routine.botId === bot.id),
        }));
      }),
      history: authed.routines.history.handler(async ({ context, input }) =>
        listRoutineRuns(deps.prisma, context.actor, input.routineId, input.before, input.limit),
      ),
      list: authed.routines.list.handler(async ({ context, input }) => {
        await repos.getBot(context.actor, input.botId);
        return listRoutinesDto(deps, context.actor, input.botId);
      }),
      create: authed.routines.create.handler(async ({ context, input }) => {
        assertRoutineSchedule(input);
        const bot = await repos.getBot(context.actor, input.botId);
        if (input.watch) await assertRoutineWatch(input.watch, context.actor, bot);
        if (input.emailSenders) {
          await assertEmailTrigger(deps.prisma, deps.env.inboundEmailDomain, bot.id);
        }
        await assertRoutineModel(deps, context.actor, input, codexCatalog);
        const data = routineRowData(context.actor, input, routineNextRunAt(input));
        const endError = routineEndError(
          {
            ...data,
            watch: input.watch,
            events: hasRoutineEvents(input),
          },
          { end: true, nextRun: true },
        );
        if (endError) throw new ClientError("BAD_REQUEST", endError);
        const row = await deps.prisma.routine.create({ data });
        await announceRoutine(context.actor, bot, row);
        await postRoutineNotice(deps, {
          spaceId: context.actor.spaceId,
          threadId: row.threadId ?? bot.thread?.id,
          botId: bot.id,
          change: "created",
          name: row.name,
          routine: { webhookEnabled: row.webhookEnabled, active: row.active },
        });
        return await routineView(deps, context.actor, row);
      }),
      update: authed.routines.update.handler(async ({ context, input }) => {
        // Archived bots keep their routines paused, so resolve an active parent before any write.
        const existing = await deps.prisma.routine.findFirst({
          where: {
            id: input.routineId,
            spaceId: context.actor.spaceId,
            bot: { archivedAt: null },
          },
        });
        if (!existing) throw new ORPCError("NOT_FOUND");
        // A routine runs with its owner's accounts, so only they change what it does. Anyone in
        // the Space may still turn it on or off, which keeps it theirs.
        if (existing.userId !== context.actor.userId) {
          const { routineId: _routineId, active: _active, ...changes } = input;
          if (Object.values(changes).some((value) => value !== undefined)) {
            throw new ClientError("FORBIDDEN", "Only the routine's owner can change it.");
          }
        }
        const bot = await repos.getBot(context.actor, existing.botId);
        const active = input.active ?? existing.active;
        const crons = input.crons ?? existing.crons;
        const timezone = input.timezone ?? existing.timezone;
        const webhookEnabled = input.webhookEnabled ?? existing.webhookEnabled;
        const githubEnabled = input.githubEnabled ?? existing.githubEnabled;
        const messageProvider =
          input.messageProvider === undefined ? existing.messageProvider : input.messageProvider;
        const emailSenders =
          input.emailSenders === undefined ? existing.emailSenders : input.emailSenders;
        if (input.emailSenders && input.emailSenders !== existing.emailSenders) {
          await assertEmailTrigger(deps.prisma, deps.env.inboundEmailDomain, bot.id);
        }
        const modelProvider =
          input.modelProvider === undefined ? existing.modelProvider : input.modelProvider;
        const modelId = input.modelId === undefined ? existing.modelId : input.modelId;
        const hasModel = Boolean(modelProvider && modelId);
        const modelChanged =
          canonicalPiProviderId(modelProvider ?? "") !==
            canonicalPiProviderId(existing.modelProvider ?? "") || modelId !== existing.modelId;
        const touchesModel =
          input.modelProvider !== undefined ||
          input.modelId !== undefined ||
          input.thinkingLevel !== undefined;
        if (Boolean(modelProvider) !== Boolean(modelId)) {
          throw new ORPCError("BAD_REQUEST", {
            message: "Model provider and model id must both be set or both cleared",
          });
        }
        if (input.thinkingLevel && !hasModel) {
          throw new ORPCError("BAD_REQUEST", { message: "Pick a model for this routine first" });
        }
        // A thinking level belongs to a model, so changing the model resets it.
        const thinkingLevel = !hasModel
          ? null
          : input.thinkingLevel === undefined
            ? modelChanged
              ? null
              : existing.thinkingLevel
            : input.thinkingLevel;
        if (modelChanged) {
          await assertRoutineModel(deps, context.actor, { modelProvider, modelId }, codexCatalog);
        }
        const watch = input.watch === undefined ? parseRoutineWatch(existing.watch) : input.watch;
        if (input.watch) await assertRoutineWatch(input.watch, context.actor, bot);
        const watchChanged =
          input.watch !== undefined &&
          stableStringify(input.watch) !== stableStringify(parseRoutineWatch(existing.watch));
        if (
          crons.length === 0 &&
          !webhookEnabled &&
          !githubEnabled &&
          !messageProvider &&
          !emailSenders &&
          !watch
        ) {
          throw new ORPCError("BAD_REQUEST", { message: ROUTINE_TRIGGER_REQUIRED });
        }
        if (watch && crons.length > 0) {
          throw new ORPCError("BAD_REQUEST", {
            message: "A change trigger checks on its own interval; remove the schedule",
          });
        }
        if (hasMixedOneShotSchedule(crons)) {
          throw new ORPCError("BAD_REQUEST", {
            message: "A one-time schedule can't be combined with other schedules.",
          });
        }
        if (active && isOneShotRoutineCrons(crons)) {
          if (!isOneShotRoutineCrons(existing.crons)) {
            throw new ORPCError("BAD_REQUEST", {
              message: "One-shot schedules must be created from chat.",
            });
          }
          if (!existing.nextRunAt && existing.lastRunAt) {
            throw new ORPCError("BAD_REQUEST", {
              message: "This one-shot already ran.",
            });
          }
        }
        const scheduleChanged =
          (!existing.active && active) ||
          (input.crons !== undefined &&
            JSON.stringify(input.crons) !== JSON.stringify(existing.crons)) ||
          (input.timezone !== undefined && input.timezone !== existing.timezone);
        const endsAt =
          input.endsAt === undefined
            ? routineEndInZone(existing.endsAt, existing.timezone, timezone)
            : input.endsAt === null
              ? null
              : new Date(input.endsAt);
        const endChanged = endsAt?.getTime() !== existing.endsAt?.getTime();
        const onLastRun = routineEnded(existing);
        const resumes = !existing.nextRunAt && (!onLastRun || endChanged);
        const recalculatedNextRunAt =
          crons.length > 0 &&
          !isOneShotRoutineCrons(crons) &&
          (scheduleChanged || (active && resumes))
            ? onLastRun
              ? runBeforeEnd(nextRoutineDate(crons, timezone), endsAt)
              : nextRoutineDate(crons, timezone)
            : null;
        let armedOneShotAt: Date | null = null;
        if (active && isOneShotRoutineCrons(crons) && !existing.nextRunAt && !existing.lastRunAt) {
          if (!input.runAt) {
            throw new ORPCError("BAD_REQUEST", {
              message: "Add a run time for this one-shot.",
            });
          }
          const parsed = new Date(input.runAt);
          if (!Number.isFinite(parsed.getTime()) || parsed.getTime() <= Date.now()) {
            throw new ORPCError("BAD_REQUEST", {
              message: "Run time must be in the future.",
            });
          }
          armedOneShotAt = parsed;
        } else if (input.runAt !== undefined) {
          throw new ORPCError("BAD_REQUEST", {
            message: "A run time is only for one-shots that have not run yet.",
          });
        }
        const nextRunAt = !active
          ? null
          : watch
            ? // Turning a watch on, or changing it, checks right away; otherwise keep its rhythm.
              !existing.active || watchChanged || resumes
              ? firstWatchCheck()
              : existing.nextRunAt
            : crons.length === 0
              ? null
              : isOneShotRoutineCrons(crons)
                ? (armedOneShotAt ?? existing.nextRunAt)
                : (recalculatedNextRunAt ?? existing.nextRunAt);
        const endError = routineEndError(
          {
            endsAt,
            crons,
            watch,
            nextRunAt,
            events: hasRoutineEvents({
              webhookEnabled,
              githubEnabled,
              messageProvider,
              emailSenders,
            }),
          },
          {
            end: input.endsAt !== undefined && endChanged,
            nextRun: endChanged || nextRunAt?.getTime() !== existing.nextRunAt?.getTime(),
          },
        );
        if (endError) throw new ClientError("BAD_REQUEST", endError);
        // What a watch read is not the owner's words, so it never runs as a turn in the chat.
        const inChat = watch ? false : input.inChat;
        const computerPromptHash =
          input.useComputer === undefined
            ? undefined
            : input.useComputer
              ? await approveComputerPrompt({
                  ...existing,
                  // The text the owner's editor showed, never a stored one they may not have seen.
                  prompt: input.prompt,
                  inChat: inChat ?? existing.inChat,
                  watch,
                  botUserId: bot.userId,
                  eventTriggered: Boolean(
                    webhookEnabled || githubEnabled || messageProvider || emailSenders,
                  ),
                })
              : null;
        const writesSchedule = nextRunAt?.getTime() !== existing.nextRunAt?.getTime();
        // An explicit on/off must not undo an enable, a disable or a finished one-shot that landed
        // after the read; neither may a schedule change computed from the old on/off state.
        const writesActive = input.active !== undefined || scheduleChanged || watchChanged;
        // Re-check the parent in the write itself so an archive that lands after the read wins.
        // Model and schedule patches must also match the snapshot they were computed from, so a
        // tick that fired after the read is not rewound onto an occurrence that already ran.
        const writeRoutine = (client: Prisma.TransactionClient) =>
          client.routine.update({
            where: {
              id: existing.id,
              bot: { archivedAt: null },
              // Optimistic fence: every write must match the snapshot it was
              // computed from, so concurrent edits never silently overwrite
              // each other's prompt/name/notify/any other field.
              updatedAt: existing.updatedAt,
              ...(touchesModel
                ? {
                    modelProvider: existing.modelProvider,
                    modelId: existing.modelId,
                    thinkingLevel: existing.thinkingLevel,
                  }
                : {}),
              ...(writesSchedule ? { nextRunAt: existing.nextRunAt } : {}),
              ...(writesActive ? { active: existing.active } : {}),
            },
            data: {
              name: input.name,
              prompt: input.prompt,
              crons: input.crons,
              timezone: input.timezone,
              active: input.active,
              // An explicit on or off is the member's own choice, so a restore must not undo it.
              ...(input.active !== undefined ? { resumeOnRestore: false } : {}),
              notify: input.notify,
              inChat,
              // Changing the prompt without this clears it (see the routines table's trigger).
              ...(computerPromptHash === undefined ? {} : { computerPromptHash }),
              webhookEnabled: input.webhookEnabled,
              githubEnabled: input.githubEnabled,
              messageProvider: input.messageProvider,
              emailSenders: input.emailSenders,
              ...(touchesModel ? { modelProvider, modelId, thinkingLevel } : {}),
              // A changed watch starts from a fresh baseline.
              ...(input.watch === undefined
                ? {}
                : { watch: (input.watch as Prisma.InputJsonValue | null) ?? Prisma.DbNull }),
              ...(watchChanged ? { watchState: Prisma.DbNull } : {}),
              ...(writesSchedule ? { nextRunAt } : {}),
              ...(endChanged ? { endsAt } : {}),
            },
          });
        const write =
          typeof computerPromptHash === "string"
            ? deps.prisma.$transaction(async (tx) => {
                // Pairing checked again under the lock a device change takes, so a computer
                // paired or unpaired since the check above can't leave this approval standing.
                await lockOwnerComputerApproval(tx, existing.userId);
                if (!(await deps.userDevices?.pairedSince(existing.userId))) {
                  throw new ClientError("BAD_REQUEST", "This routine can't use your computer.");
                }
                // The table's trigger clears an approval left unchanged by a rename; this
                // update approves the routine afresh, so it starts from none.
                await tx.$executeRaw`UPDATE "routines" SET "computerPromptHash" = NULL WHERE "id" = ${existing.id}`;
                return writeRoutine(tx);
              })
            : writeRoutine(deps.prisma);
        const row = await write.catch(async (error: unknown) => {
          if (isRecordNotFound(error)) {
            if (
              await deps.prisma.routine.findFirst({
                where: {
                  id: existing.id,
                  spaceId: context.actor.spaceId,
                  bot: { archivedAt: null },
                },
                select: { id: true },
              })
            ) {
              throw new ClientError("CONFLICT", "Routine changed; retry.");
            }
            throw new ClientError("NOT_FOUND", "Not Found");
          }
          throw error;
        });
        if (bot.thread) {
          await deps.events.append({
            spaceId: context.actor.spaceId,
            threadId: bot.thread.id,
            botId: bot.id,
            type: "routine.updated",
            payload: { routineId: row.id, active: row.active },
          });
        }
        const scheduleNeedsSync =
          existing.active !== row.active ||
          scheduleChanged ||
          watchChanged ||
          existing.nextRunAt?.getTime() !== row.nextRunAt?.getTime() ||
          (!existing.nextRunAt && !!row.nextRunAt);
        if (scheduleNeedsSync) {
          if (row.active && row.nextRunAt) {
            await deps.jobs.enqueue(routineWakeupJob(row.id, row.nextRunAt));
          } else {
            await deps.jobs.cancel(routineJobKey(row.id));
          }
        }
        if (routineEdited(existing, row)) {
          await postRoutineNotice(deps, {
            spaceId: context.actor.spaceId,
            threadId: existing.threadId ?? bot.thread?.id,
            botId: bot.id,
            change: routineEditChange(existing, row),
            name: row.name,
            routine: { webhookEnabled: row.webhookEnabled, active: row.active },
          });
        }
        return await routineView(deps, context.actor, row);
      }),
      remove: authed.routines.remove.handler(async ({ context, input }) => {
        // Any member can delete a routine, as they can turn it off.
        const existing = await deps.prisma.routine.findFirst({
          where: { id: input.routineId, spaceId: context.actor.spaceId },
        });
        if (!existing) throw new IsolationError();
        await deps.prisma.routine.delete({ where: { id: existing.id } });
        await deps.jobs.cancel(routineJobKey(existing.id));
        await postRoutineNotice(deps, {
          spaceId: context.actor.spaceId,
          threadId: existing.threadId,
          botId: existing.botId,
          change: "deleted",
          name: existing.name,
        });
        return { ok: true as const };
      }),
      testRun: authed.routines.testRun.handler(async ({ context, input }) => {
        const nonce = input.clientNonce
          ? routineTestRunNonce(context.actor, input.clientNonce)
          : undefined;
        const findExisting = (db: Pick<PrismaClient, "run"> = deps.prisma) =>
          findRoutineTestRun(db, context.actor, input.routineId, nonce);
        // Access is checked first, so a retry can't return a run for a bot the caller lost.
        const target = await routineRunNowTarget(
          deps.prisma,
          repos,
          context.actor,
          input.routineId,
        );
        // The group chat a run went to, so the client can follow it there.
        const runResult = (run: { id: string; thread: { groupId: string | null } }) => ({
          runId: run.id,
          groupId: run.thread.groupId,
        });
        const existing = await findExisting();
        if (existing) return runResult(existing);
        const skillRecords = await agentSkills.listWithContent(context.actor);
        const prompt = expandSkillReferencesInPrompt(target.routine.prompt, skillRecords);
        let run: { id: string; thread: { groupId: string | null } };
        try {
          // Task + run must commit together so a nonce collision cannot leave an orphan queued Task.
          run = await deps.prisma.$transaction(async (tx) => {
            const existing = await findExisting(tx);
            return existing ?? createRoutineTestRun(tx, context.actor, target, prompt, nonce);
          });
        } catch (error) {
          const existing = await findExisting();
          if (existing) return runResult(existing);
          throw error;
        }
        await wakeRun(deps.jobs, run.id);
        return runResult(run);
      }),
    },
  };
}
