import { ORPCError } from "@orpc/server";
import { routineJobKey, routineWakeupJob, runContinueJob } from "@rakazo/adapter-kit";
import {
  parseRoutineWatch,
  routineRunModelPin,
  stableStringify,
  validateRoutineWatch,
} from "@rakazo/adapters";
import { canonicalPiProviderId } from "@rakazo/contracts";
import {
  expandSkillReferencesInPrompt,
  hasMixedOneShotSchedule,
  isOneShotRoutineCrons,
} from "@rakazo/core";
import { IsolationError, Prisma } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { assertRoutineModel } from "../model-pins.js";
import { listRoutineRuns } from "../routine-runs.js";
import {
  assertRoutineSchedule,
  firstWatchCheck,
  listRoutinesDto,
  mapRoutine,
  nextRoutineDate,
  routineDto,
  routineNextRunAt,
  routineRowData,
} from "../routines.js";
import type { RouterContext } from "./context.js";
import { isRecordNotFound } from "./shared.js";

export function routinesRoutes(ctx: RouterContext) {
  const { deps, repos, announceRoutine, codexCatalog, agentSkills, authed } = ctx;
  return {
    routines: {
      listForMentions: authed.routines.listForMentions.handler(async ({ context, input }) => {
        const { actor } = context;
        // Same ownership predicates as getBot, so a batch never widens what routines/list allows.
        const bots = await deps.prisma.bot.findMany({
          where: {
            id: { in: input.botIds },
            spaceId: actor.spaceId,
            userId: actor.userId,
            archivedAt: null,
          },
          select: { id: true },
        });
        const rows = await deps.prisma.routine.findMany({
          where: { botId: { in: bots.map((bot) => bot.id) }, spaceId: actor.spaceId },
        });
        return bots.map((bot) => ({
          botId: bot.id,
          routines: rows.filter((row) => row.botId === bot.id).map((row) => routineDto(row, actor)),
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
        if (input.watch) {
          try {
            await validateRoutineWatch(
              {},
              input.watch,
              { ...context.actor, botId: bot.id },
              bot.computer,
            );
          } catch (error) {
            throw new ORPCError("BAD_REQUEST", {
              message: error instanceof Error ? error.message : "Invalid change trigger.",
            });
          }
        }
        await assertRoutineModel(deps, context.actor, input, codexCatalog);
        const row = await deps.prisma.routine.create({
          data: routineRowData(context.actor, input, routineNextRunAt(input)),
        });
        await announceRoutine(context.actor, bot, row);
        return mapRoutine(row);
      }),
      update: authed.routines.update.handler(async ({ context, input }) => {
        // Archived bots keep their routines paused, so resolve an active parent before any write.
        const existing = await deps.prisma.routine.findFirst({
          where: {
            id: input.routineId,
            spaceId: context.actor.spaceId,
            userId: context.actor.userId,
            bot: { archivedAt: null },
          },
        });
        if (!existing) throw new ORPCError("NOT_FOUND");
        const bot = await repos.getBot(context.actor, existing.botId);
        const active = input.active ?? existing.active;
        const crons = input.crons ?? existing.crons;
        const timezone = input.timezone ?? existing.timezone;
        const webhookEnabled = input.webhookEnabled ?? existing.webhookEnabled;
        const githubEnabled = input.githubEnabled ?? existing.githubEnabled;
        const messageProvider =
          input.messageProvider === undefined ? existing.messageProvider : input.messageProvider;
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
        if (input.watch) {
          try {
            await validateRoutineWatch(
              {},
              input.watch,
              { ...context.actor, botId: bot.id },
              bot.computer,
            );
          } catch (error) {
            throw new ORPCError("BAD_REQUEST", {
              message: error instanceof Error ? error.message : "Invalid change trigger.",
            });
          }
        }
        const watchChanged =
          input.watch !== undefined &&
          stableStringify(input.watch) !== stableStringify(parseRoutineWatch(existing.watch));
        if (crons.length === 0 && !webhookEnabled && !githubEnabled && !messageProvider && !watch) {
          throw new ORPCError("BAD_REQUEST", {
            message: "Add a schedule, webhook, GitHub, message, or change trigger",
          });
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
        const recalculatedNextRunAt =
          crons.length > 0 &&
          !isOneShotRoutineCrons(crons) &&
          (scheduleChanged || (active && !existing.nextRunAt))
            ? nextRoutineDate(crons, timezone)
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
              !existing.active || watchChanged || !existing.nextRunAt
              ? firstWatchCheck()
              : existing.nextRunAt
            : crons.length === 0
              ? null
              : isOneShotRoutineCrons(crons)
                ? (armedOneShotAt ?? existing.nextRunAt)
                : (recalculatedNextRunAt ?? existing.nextRunAt);
        // Re-check the parent in the write itself so an archive that lands after the read wins.
        // Model patches must also match the snapshot used to resolve omitted model fields.
        const row = await deps.prisma.routine
          .update({
            where: {
              id: existing.id,
              bot: { archivedAt: null },
              ...(touchesModel
                ? {
                    modelProvider: existing.modelProvider,
                    modelId: existing.modelId,
                    thinkingLevel: existing.thinkingLevel,
                  }
                : {}),
            },
            data: {
              name: input.name,
              prompt: input.prompt,
              crons: input.crons,
              timezone: input.timezone,
              active: input.active,
              notify: input.notify,
              webhookEnabled: input.webhookEnabled,
              githubEnabled: input.githubEnabled,
              messageProvider: input.messageProvider,
              ...(touchesModel ? { modelProvider, modelId, thinkingLevel } : {}),
              // A changed watch starts from a fresh baseline.
              ...(input.watch === undefined
                ? {}
                : {
                    watch: (input.watch as Prisma.InputJsonValue | null) ?? Prisma.DbNull,
                    ...(watchChanged ? { watchState: Prisma.DbNull } : {}),
                  }),
              nextRunAt,
            },
          })
          .catch(async (error: unknown) => {
            if (isRecordNotFound(error)) {
              if (
                touchesModel &&
                (await deps.prisma.routine.findFirst({
                  where: {
                    id: existing.id,
                    spaceId: context.actor.spaceId,
                    userId: context.actor.userId,
                    bot: { archivedAt: null },
                  },
                  select: { id: true },
                }))
              ) {
                throw new ORPCError("CONFLICT", { message: "Routine model changed; retry." });
              }
              throw new ORPCError("NOT_FOUND");
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
        return mapRoutine(row);
      }),
      remove: authed.routines.remove.handler(async ({ context, input }) => {
        const existing = await deps.prisma.routine.findFirst({
          where: { id: input.routineId, spaceId: context.actor.spaceId },
        });
        if (!existing) throw new IsolationError();
        await deps.prisma.routine.delete({ where: { id: existing.id } });
        await deps.jobs.cancel(routineJobKey(existing.id));
        return { ok: true as const };
      }),
      testRun: authed.routines.testRun.handler(async ({ context, input }) => {
        const routine = await deps.prisma.routine.findFirst({
          where: {
            id: input.routineId,
            spaceId: context.actor.spaceId,
            userId: context.actor.userId,
          },
        });
        if (!routine) throw new IsolationError();
        const bot = await repos.getBot(context.actor, routine.botId);
        if (!bot.thread) throw new IsolationError();
        const threadId = bot.thread.id;
        const nonce = input.clientNonce ? `routine-test:${input.clientNonce}` : undefined;
        if (nonce) {
          const existing = await deps.prisma.run.findFirst({
            where: { threadId, clientNonce: nonce },
            select: { id: true },
          });
          if (existing) return { runId: existing.id };
        }
        const skillRecords = await agentSkills.listWithContent(context.actor);
        const prompt = expandSkillReferencesInPrompt(routine.prompt, skillRecords);
        let run: { id: string };
        try {
          // Task + run must commit together so a nonce collision cannot leave an orphan queued Task.
          run = await deps.prisma.$transaction(async (tx) => {
            if (nonce) {
              const existing = await tx.run.findFirst({
                where: { threadId, clientNonce: nonce },
                select: { id: true },
              });
              if (existing) return existing;
            }
            const task = await tx.task.create({
              data: {
                spaceId: context.actor.spaceId,
                botId: bot.id,
                threadId,
                userId: context.actor.userId,
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
                spaceId: context.actor.spaceId,
                botId: bot.id,
                threadId,
                taskId: task.id,
                userId: context.actor.userId,
                status: "queued",
                trigger: "routine",
                routineId: routine.id,
                ...routineRunModelPin(currentModel),
                clientNonce: nonce,
              },
              select: { id: true },
            });
          });
        } catch (error) {
          if (nonce) {
            const existing = await deps.prisma.run.findFirst({
              where: { threadId, clientNonce: nonce },
              select: { id: true },
            });
            if (existing) return { runId: existing.id };
          }
          throw error;
        }
        // Keep enqueue outside the nonce-collision catch. The queued run is durable;
        // log enqueue failures and still return success — the reconciler repairs a missed wake.
        await deps.jobs.enqueue(runContinueJob(run.id)).catch((error) => {
          getLogger().error("routine testRun enqueue", error);
        });
        return { runId: run.id };
      }),
    },
  };
}
