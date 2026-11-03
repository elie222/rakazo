import { BotSettingsValuesSchema } from "@rakazo/contracts";
import { redactSecrets } from "@rakazo/core";
import {
  commitBotUpdate,
  createSpaceForMember,
  InstructionConflictError,
  InvalidSpaceNameError,
  runAsSystem,
  SpaceLimitError,
  writeBotInstructions,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { uncertainEffectResult } from "./approval-effect.js";
import { archiveSpawnedBot, spawnBot } from "./child-bots.js";
import {
  createChildRoutine,
  createFleetGroup,
  listFleet,
  organizeBot,
  setChildBotModel,
  setChildInstructions,
  updateChildBot,
  updateFleetGroup,
  updateOwnBotFromTool,
} from "./fleet-tools.js";
import {
  listDefaultVoices,
  prepareOwnBotSettings,
  readOwnBotSettings,
} from "./own-bot-settings.js";
import type { RunContext } from "./run-context.js";
import { mayOpenModelStream } from "./run-lifecycle.js";
import { persistMessageInTransaction, publishMessage } from "./run-messages.js";
import { fleetPrepareDeps } from "./run-model.js";
import type { ToolCall, ToolHandlers } from "./run-tool-gate.js";
import { argumentGiven } from "./update-bot-patch.js";

async function archiveBot(ctx: RunContext, call: ToolCall) {
  const { deps, run, bot, thread, context } = ctx;
  const { name, args } = call;
  const archived = await archiveSpawnedBot(
    deps,
    {
      spawnedByBotId: bot.id,
      userId: run.userId,
      spaceId: run.spaceId,
      confirmName: String(args.confirm_name ?? args.confirmName ?? ""),
      botId: args.bot_id ? String(args.bot_id) : args.botId ? String(args.botId) : undefined,
    },
    context,
  );
  if ("error" in archived) return call.finish(archived);
  if (!(await call.persistEffectResult(archived))) return uncertainEffectResult(name);
  try {
    await publishMessage(deps, run, "bot", [
      {
        kind: "child_bot",
        botId: archived.botId,
        name: archived.name,
        status: "archived",
      },
    ]);
    await deps.events.append({
      spaceId: run.spaceId,
      threadId: thread.id,
      botId: bot.id,
      runId: run.id,
      type: "bot.archived",
      payload: { childBotId: archived.botId, name: archived.name },
    });
  } catch (error) {
    getLogger().error("archived bot notification", error);
  }
  return archived;
}

/** Writes this bot's instructions and posts the change, with its undo, in the chat. */
async function commitOwnInstructions(
  ctx: RunContext,
  input: {
    instructions: string;
    reason: string;
    previousInstructions: string;
  },
): Promise<{ ok: true } | { error: string }> {
  const { deps, run, runId, bot, context } = ctx;
  const committed = await deps.prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${run.threadId} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM runs WHERE id = ${runId} FOR UPDATE`;
    const live = await tx.run.findUnique({ where: { id: runId } });
    if (!mayOpenModelStream(live, ctx.workerId, ctx.fence, context.signal.aborted)) {
      throw new Error("Instruction update run is no longer active.");
    }
    let undoVersionId: string | null;
    try {
      undoVersionId = await writeBotInstructions(tx, {
        botId: bot.id,
        instructions: input.instructions,
        reason: input.reason,
        expectedInstructions: input.previousInstructions,
      });
    } catch (error) {
      if (!(error instanceof InstructionConflictError)) throw error;
      return { error: error.message };
    }
    if (!undoVersionId) return null;
    return persistMessageInTransaction(tx, run, "bot", [
      {
        kind: "ask",
        text: "Instructions updated",
        status: "answered",
        instructionUpdate: {
          botId: bot.id,
          before: redactSecrets(input.previousInstructions, ctx.secrets),
          after: input.instructions,
          reason: input.reason,
          undoVersionId,
        },
      },
    ]);
  });
  if (committed && "error" in committed) return committed;
  if (committed)
    await deps.events
      .notify(run.threadId, committed.eventSeq, committed.firstResponseRunId)
      .catch((error) => getLogger().error("instruction update realtime notification", error));
  return { ok: true };
}

/** This bot's own settings, Spaces and the bots this bot manages. */
export const fleetTools: ToolHandlers = {
  async create_space(ctx, call) {
    const { deps, run } = ctx;
    const { args } = call;
    try {
      // The new Space's rows are outside the run's tenant until it exists.
      const space = await runAsSystem("create a Space for its member", () =>
        createSpaceForMember(deps.prisma, {
          currentSpaceId: run.spaceId,
          userId: run.userId,
          name: String(args.name ?? ""),
        }),
      );
      return call.finish({ ok: true, spaceId: space.id, name: space.name });
    } catch (error) {
      if (error instanceof SpaceLimitError || error instanceof InvalidSpaceNameError) {
        return call.finish({ error: error.message });
      }
      throw error;
    }
  },
  async spawn_bot(ctx, call) {
    const { deps, run, runId, bot, thread } = ctx;
    const { name, args, effectKey } = call;
    const computerModeArg = args.computer_mode;
    let computerMode: "team" | "dedicated" | undefined;
    if (computerModeArg != null && computerModeArg !== "") {
      const value = String(computerModeArg);
      if (value !== "team" && value !== "dedicated") {
        return call.finish({
          error: 'computer_mode must be "team" or "dedicated".',
        });
      }
      computerMode = value;
    }
    const spawned = await spawnBot(deps, {
      spawnedBy: {
        id: bot.id,
        name: bot.name,
        spaceId: bot.spaceId,
        userId: run.userId,
      },
      runId,
      spawnKey: effectKey,
      name: String(args.name ?? ""),
      description: args.description ? String(args.description) : undefined,
      instructions: args.instructions ? String(args.instructions) : undefined,
      prompt: args.prompt ? String(args.prompt) : undefined,
      computerMode,
    });
    if ("error" in spawned) return call.finish(spawned);
    if (!(await call.persistEffectResult(spawned))) return uncertainEffectResult(name);
    try {
      await publishMessage(deps, run, "bot", [
        {
          kind: "child_bot",
          botId: spawned.botId,
          name: spawned.name,
          status: "created",
        },
      ]);
      await deps.events.append({
        spaceId: run.spaceId,
        threadId: thread.id,
        botId: bot.id,
        runId: run.id,
        type: "bot.spawned",
        payload: { childBotId: spawned.botId, name: spawned.name },
      });
    } catch (error) {
      getLogger().error("spawned bot notification", error);
    }
    return spawned;
  },
  async list_fleet(ctx, call) {
    const { deps } = ctx;
    const { args } = call;
    return call.finish(await listFleet(deps, ctx.fleetRun, args));
  },
  async organize_bot(ctx, call) {
    const { deps } = ctx;
    const { args } = call;
    return call.finish(await organizeBot({ ...deps, runSecrets: ctx.secrets }, ctx.fleetRun, args));
  },
  // Replay hands these the canonical request stored with the approved effect.
  async create_group(ctx, call) {
    const { deps } = ctx;
    const { args } = call;
    return call.finish(await createFleetGroup(deps, ctx.fleetRun, args));
  },
  async update_group(ctx, call) {
    const { deps } = ctx;
    const { args } = call;
    return call.finish(await updateFleetGroup(deps, ctx.fleetRun, args));
  },
  async set_child_instructions(ctx, call) {
    const { deps } = ctx;
    const { args } = call;
    return call.finish(await setChildInstructions(deps, ctx.fleetRun, args));
  },
  async set_child_bot_model(ctx, call) {
    const { deps, run } = ctx;
    const { args } = call;
    const modelDeps = { ...(await fleetPrepareDeps(deps, run)), events: deps.events };
    return call.finish(await setChildBotModel(modelDeps, ctx.fleetRun, args));
  },
  async create_child_routine(ctx, call) {
    const { deps } = ctx;
    const { args } = call;
    return call.finish(await createChildRoutine(deps, ctx.fleetRun, args));
  },
  async update_bot(ctx, call) {
    const { deps, run, bot, thread, context } = ctx;
    const { args } = call;
    if (argumentGiven(args.bot_id)) {
      return call.finish(
        await updateChildBot({ ...deps, runSecrets: ctx.secrets }, ctx.fleetRun, args),
      );
    }
    // A change held for the owner (see prepareOwnBotUpdate) runs only once they approve it.
    if (typeof args.previousInstructions === "string") {
      if ((call.nextApprovedTool !== call.name && !call.bypassApproval) || !call.claimedEffect)
        return call.finish({ error: "This instruction change needs the owner's approval." });
      return call.finish(
        await commitOwnInstructions(ctx, {
          instructions: String(args.instructions),
          reason: String(args.reason),
          previousInstructions: args.previousInstructions,
        }),
      );
    }
    const { instructions, model, thinkingLevel, readAloud, voice, ...profile } = args;
    const modelDeps = await fleetPrepareDeps(deps, run);
    const live = await deps.prisma.bot.findUniqueOrThrow({
      where: { id: bot.id },
      select: {
        name: true,
        description: true,
        instructions: true,
        color: true,
        notifyOnFinish: true,
        modelProvider: true,
        modelId: true,
        thinkingLevel: true,
        autoSpeak: true,
        voiceId: true,
      },
    });
    if (!Object.values(args).some(argumentGiven))
      return call.finish(await readOwnBotSettings(modelDeps, run, live));
    const settings = await prepareOwnBotSettings(
      modelDeps,
      run,
      live,
      { model, thinkingLevel, readAloud, voice },
      () => listDefaultVoices(deps, run, context),
    );
    if ("error" in settings) return call.finish(settings);
    const before = BotSettingsValuesSchema.parse(
      Object.fromEntries(
        Object.keys(settings.data).map((key) => [key, live[key as keyof typeof settings.data]]),
      ),
    );
    // The profile goes first, so a rejected field leaves everything else unchanged for a retry.
    const updated = Object.values(profile).some(argumentGiven)
      ? await updateOwnBotFromTool(deps, run, thread.id, bot, profile, context)
      : undefined;
    if (updated && "error" in updated) return call.finish(updated);
    if (
      Object.entries(settings.data).some(
        ([key, value]) => before[key as keyof typeof before] !== value,
      )
    ) {
      try {
        await commitBotUpdate({
          prisma: deps.prisma,
          notify: (threadId, seq) => deps.events.notify(threadId, seq),
          spaceId: run.spaceId,
          threadId: thread.id,
          botId: bot.id,
          emitBotUpdated: true,
          expectedSettings: before,
          data: settings.data,
        });
      } catch (error) {
        if (!(error && typeof error === "object" && "code" in error && error.code === "P2025"))
          throw error;
        return call.finish({ error: "Your settings changed meanwhile; read them and try again." });
      }
      await publishMessage(deps, run, "bot", [
        {
          kind: "ask",
          text: "Settings updated",
          status: "answered",
          settingsUpdate: { botId: bot.id, before, after: settings.data },
        },
      ]).catch((error) => getLogger().error("settings update card", error));
    }
    if (argumentGiven(instructions)) {
      const set = await commitOwnInstructions(ctx, {
        instructions: String(instructions),
        reason: "Set in chat",
        previousInstructions: live.instructions,
      });
      if ("error" in set)
        return call.finish({
          error: `${updated || Object.keys(settings.data).length ? "Your other changes were saved, but your instructions were not: " : ""}${set.error}`,
        });
    }
    return call.finish({
      ok: true,
      ...updated,
      ...(settings.data.modelId !== undefined
        ? { model: `${settings.data.modelProvider}/${settings.data.modelId}` }
        : {}),
      ...(settings.data.thinkingLevel !== undefined
        ? { thinkingLevel: settings.data.thinkingLevel ?? "default" }
        : {}),
      ...(settings.data.autoSpeak !== undefined ? { readAloud: settings.data.autoSpeak } : {}),
      ...(settings.data.voiceId !== undefined ? { voice: settings.data.voiceId ?? "default" } : {}),
      ...(argumentGiven(instructions) ? { instructions: "updated" } : {}),
    });
  },
  archive_bot: archiveBot,
  delete_bot: archiveBot,
};
