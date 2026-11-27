import { redactSecrets } from "@rakazo/core";
import type { FleetCardSummary } from "../../approvals/approval-ask.js";
import { approvalDetailLength, MAX_APPROVAL_SUMMARY_LENGTH } from "../../approvals/approval-ask.js";
import {
  desktopGuardApplies,
  desktopGuardRefusalMessage,
  protectedComputerLifecycleRefusal,
} from "../../providers/computer/desktop/desktop-command-guard.js";
import { findRoutinesTarget } from "../../routines/routine-target.js";
import {
  addScratchpadItemFromTool,
  completeScratchpadItemFromTool,
  listScratchpadItemsFromTool,
  removeScratchpadItemFromTool,
  updateScratchpadItemFromTool,
} from "../../tasks/scratchpad-tools.js";
import { taskCatalogFromTool } from "../../tasks/task-catalog.js";
import {
  commentTicket,
  createTicket,
  getTicket,
  listBoardTickets,
  updateTicket,
} from "../../tasks/ticket-tools.js";
import { cardName } from "../../tools/fleet-tools.js";
import type { ScheduleToolDeps } from "../../tools/schedule-tools.js";
import {
  cancelScheduleFromTool,
  commandWatchFromTool,
  compactScheduleInput,
  createScheduleFromTool,
  isScheduleValueProvided,
  listSchedulesFromTool,
  scheduleCreateError,
  scheduleCreateFields,
  scheduleTimingArgs,
  updateScheduleFromTool,
} from "../../tools/schedule-tools.js";
import { routineApprovalChanges, routineApprovalLines } from "../../tools/schedule-update-view.js";
import {
  skillCreateFromTool,
  skillDeleteFromTool,
  skillReadFromTool,
  skillUpdateFromTool,
} from "../../tools/skill-tools.js";
import type { RunContext } from "../assembly/run-context.js";
import type { ToolHandlers } from "./run-tool-gate.js";

/** A command watch may not run what the desktop guard keeps the bot from running itself. */
function commandWatchGuardError(ctx: RunContext, watch: unknown): string | undefined {
  const command = commandWatchFromTool(watch);
  const refusal = command === undefined ? undefined : protectedComputerLifecycleRefusal(command);
  return desktopGuardApplies(ctx.computer) && refusal ? desktopGuardRefusalMessage() : undefined;
}

/**
 * What `schedule_create` refuses before saving anything. Checked before the approval gate,
 * so a routine that cannot be saved returns its error and shows no card; the handler checks again.
 */
export async function scheduleCreateRefusal(
  ctx: RunContext,
  args: Record<string, unknown>,
): Promise<{ error: string } | undefined> {
  const { deps, run, bot, thread } = ctx;
  const error =
    commandWatchGuardError(ctx, args.watch) ??
    (await scheduleCreateError(deps, {
      spaceId: run.spaceId,
      botId: bot.id,
      userId: run.userId,
      threadId: thread.id,
      ...scheduleCreateFields(args),
    }));
  return error ? { error } : undefined;
}

/** The task catalog, scratchpad, ticket board, schedules and skills. */
export const taskTools: ToolHandlers = {
  async task_catalog(ctx) {
    const { deps, run, bot, thread } = ctx;
    return taskCatalogFromTool(deps, {
      spaceId: run.spaceId,
      botId: bot.id,
      userId: run.userId,
      ...(thread.groupId ? { groupThreadId: thread.id } : {}),
      tools: ctx.tools.offered,
    });
  },
  async scratchpad_list(ctx, call) {
    const { deps, run, bot } = ctx;
    const { args } = call;
    return listScratchpadItemsFromTool(deps, {
      spaceId: run.spaceId,
      botId: bot.id,
      includeDone: Boolean(args.includeDone),
    });
  },
  async scratchpad_add(ctx, call) {
    const { deps, run, bot } = ctx;
    const { args } = call;
    const created = await addScratchpadItemFromTool(deps, {
      spaceId: run.spaceId,
      botId: bot.id,
      userId: run.userId,
      title: String(args.title ?? ""),
      status: args.status ? String(args.status) : undefined,
      notes: args.notes !== undefined ? String(args.notes) : undefined,
    });
    return call.finish(created);
  },
  async scratchpad_update(ctx, call) {
    const { deps, run, bot } = ctx;
    const { args } = call;
    const updated = await updateScratchpadItemFromTool(deps, {
      spaceId: run.spaceId,
      botId: bot.id,
      userId: run.userId,
      itemId: String(args.itemId ?? ""),
      title: args.title !== undefined ? String(args.title) : undefined,
      status: args.status !== undefined ? String(args.status) : undefined,
      notes: args.notes !== undefined ? String(args.notes) : undefined,
    });
    return call.finish(updated);
  },
  async scratchpad_complete(ctx, call) {
    const { deps, run, bot } = ctx;
    const { args } = call;
    const completed = await completeScratchpadItemFromTool(deps, {
      spaceId: run.spaceId,
      botId: bot.id,
      userId: run.userId,
      itemId: String(args.itemId ?? ""),
    });
    return call.finish(completed);
  },
  async scratchpad_remove(ctx, call) {
    const { deps, run, bot } = ctx;
    const { args } = call;
    const removed = await removeScratchpadItemFromTool(deps, {
      spaceId: run.spaceId,
      botId: bot.id,
      userId: run.userId,
      itemId: String(args.itemId ?? ""),
    });
    return call.finish(removed);
  },
  async board_tickets(ctx, call) {
    const { deps, run } = ctx;
    const { args } = call;
    return call.finish(
      await listBoardTickets(deps, {
        spaceId: run.spaceId,
        status: args.status !== undefined ? String(args.status) : undefined,
        assigneeBotId: args.ownerBotId !== undefined ? String(args.ownerBotId) : undefined,
        cursor: args.cursor !== undefined ? String(args.cursor) : undefined,
      }),
    );
  },
  async ticket_get(ctx, call) {
    const { deps, run } = ctx;
    const { args } = call;
    return call.finish(
      await getTicket(deps, {
        spaceId: run.spaceId,
        ref: String(args.ref ?? ""),
      }),
    );
  },
  async ticket_create(ctx, call) {
    const { deps, run, bot } = ctx;
    const { args } = call;
    return call.finish(
      await createTicket(deps, {
        spaceId: run.spaceId,
        botId: bot.id,
        userId: run.userId,
        title: String(args.title ?? ""),
        description: args.description !== undefined ? String(args.description) : undefined,
        priority: args.priority !== undefined ? String(args.priority) : undefined,
        ownerBotId: args.ownerBotId !== undefined ? String(args.ownerBotId) : undefined,
      }),
    );
  },
  async ticket_update(ctx, call) {
    const { deps, run, bot } = ctx;
    const { args } = call;
    return call.finish(
      await updateTicket(deps, {
        spaceId: run.spaceId,
        botId: bot.id,
        userId: run.userId,
        id: String(args.id ?? ""),
        title: args.title !== undefined ? String(args.title) : undefined,
        description: args.description !== undefined ? String(args.description) : undefined,
        priority: args.priority !== undefined ? String(args.priority) : undefined,
        status: args.status !== undefined ? String(args.status) : undefined,
        ownerBotId: args.ownerBotId !== undefined ? String(args.ownerBotId) : undefined,
      }),
    );
  },
  async ticket_comment(ctx, call) {
    const { deps, run, bot } = ctx;
    const { args } = call;
    return call.finish(
      await commentTicket(deps, {
        spaceId: run.spaceId,
        botId: bot.id,
        userId: run.userId,
        id: String(args.id ?? ""),
        body: String(args.body ?? ""),
      }),
    );
  },
  async schedule_create(ctx, call) {
    const { deps, run, bot, thread } = ctx;
    const { args } = call;
    const refusal = commandWatchGuardError(ctx, args.watch);
    if (refusal) return call.finish({ error: refusal });
    const created = await createScheduleFromTool(deps, {
      spaceId: run.spaceId,
      botId: bot.id,
      userId: run.userId,
      threadId: thread.id,
      ...scheduleCreateFields(args),
    });
    return call.finish(created);
  },
  async schedule_update(ctx, call) {
    return call.finish(
      await onScheduleUpdateCall(ctx, call.args, (deps, input) =>
        updateScheduleFromTool(deps, input),
      ),
    );
  },
  async schedule_list(ctx, call) {
    const { deps, run } = ctx;
    const target = await routinesTarget(ctx, call.name, call.args);
    if ("error" in target) return target;
    return listSchedulesFromTool(deps, {
      spaceId: run.spaceId,
      botId: target.botId,
      ...(target.groupThreadId ? { groupThreadId: target.groupThreadId } : {}),
    });
  },
  async schedule_cancel(ctx, call) {
    const { deps, run } = ctx;
    const { args } = call;
    const target = await routinesTarget(ctx, call.name, args);
    if ("error" in target) return call.finish(target);
    const cancelled = await cancelScheduleFromTool(deps, {
      spaceId: run.spaceId,
      botId: target.botId,
      ...(target.groupThreadId ? { threadId: target.groupThreadId } : {}),
      routineId: args.routineId ? String(args.routineId) : undefined,
      name: args.name ? String(args.name) : undefined,
    });
    return call.finish(cancelled);
  },
  async skill_read(ctx, call) {
    const { deps, run } = ctx;
    const { args } = call;
    return skillReadFromTool(
      deps.prisma,
      {
        spaceId: run.spaceId,
        userId: run.userId,
      },
      {
        name: args.name ? String(args.name) : undefined,
        skillId: args.skillId ? String(args.skillId) : undefined,
        file: args.file ? String(args.file) : undefined,
      },
    );
  },
  async skill_create(ctx, call) {
    const { deps, run } = ctx;
    const { args } = call;
    return call.finish(
      await skillCreateFromTool(
        deps.prisma,
        {
          spaceId: run.spaceId,
          userId: run.userId,
        },
        {
          name: args.name ? String(args.name) : undefined,
          description: args.description ? String(args.description) : undefined,
          body: args.body ? String(args.body) : undefined,
          content: args.content ? String(args.content) : undefined,
        },
      ),
    );
  },
  async skill_update(ctx, call) {
    const { deps, run } = ctx;
    const { args } = call;
    return call.finish(
      await skillUpdateFromTool(
        deps.prisma,
        {
          spaceId: run.spaceId,
          userId: run.userId,
        },
        {
          name: args.name ? String(args.name) : undefined,
          skillId: args.skillId ? String(args.skillId) : undefined,
          newName: args.newName ? String(args.newName) : undefined,
          description: args.description !== undefined ? String(args.description) : undefined,
          body: args.body !== undefined ? String(args.body) : undefined,
          content: args.content ? String(args.content) : undefined,
        },
        deps.events,
      ),
    );
  },
  async skill_delete(ctx, call) {
    const { deps, run } = ctx;
    const { args } = call;
    return call.finish(
      await skillDeleteFromTool(
        deps.prisma,
        {
          spaceId: run.spaceId,
          userId: run.userId,
        },
        {
          name: args.name ? String(args.name) : undefined,
          skillId: args.skillId ? String(args.skillId) : undefined,
        },
      ),
    );
  },
};

function routinesTarget(ctx: RunContext, name: string, args: Record<string, unknown>) {
  const { deps, fleetRun, bot, thread } = ctx;
  return findRoutinesTarget({ prisma: deps.prisma, fleetRun, botId: bot.id, thread }, name, args);
}

/** A schedule_update call's fields, as its save and its preview both take them. */
function scheduleUpdateInput(args: Record<string, unknown>) {
  const expected = args.expected as { name?: unknown; prompt?: unknown } | undefined;
  const expectedName = typeof expected?.name === "string" ? expected.name : undefined;
  const expectedPrompt = typeof expected?.prompt === "string" ? expected.prompt : undefined;
  return {
    routineId: String(args.routineId ?? ""),
    name: isScheduleValueProvided(args.name) ? String(args.name) : undefined,
    prompt: isScheduleValueProvided(args.prompt) ? String(args.prompt) : undefined,
    inChat: typeof args.inChat === "boolean" ? args.inChat : undefined,
    active: typeof args.active === "boolean" ? args.active : undefined,
    timezone: isScheduleValueProvided(args.timezone) ? String(args.timezone) : undefined,
    schedule: compactScheduleInput(scheduleTimingArgs(args)),
    everyMinutes: isScheduleValueProvided(args.everyMinutes) ? args.everyMinutes : undefined,
    on: isScheduleValueProvided(args.on) ? args.on : undefined,
    endAt: isScheduleValueProvided(args.endAt) ? String(args.endAt) : undefined,
    // The pinned before-values an approval was shown against, for the fields it writes.
    ...(expectedName !== undefined || expectedPrompt !== undefined
      ? {
          expected: {
            ...(expectedName !== undefined ? { name: expectedName } : {}),
            ...(expectedPrompt !== undefined ? { prompt: expectedPrompt } : {}),
          },
        }
      : {}),
  };
}

/**
 * Runs `apply` on a schedule_update call's target and fields, or answers why the call has no
 * target. The save and the card shown before it both go through here, so they read one call.
 */
async function onScheduleUpdateCall<T>(
  ctx: RunContext,
  args: Record<string, unknown>,
  apply: (
    deps: ScheduleToolDeps,
    input: Parameters<typeof updateScheduleFromTool>[1],
  ) => Promise<T>,
): Promise<T | { error: string }> {
  const { deps, run } = ctx;
  const target = await routinesTarget(ctx, "schedule_update", args);
  if ("error" in target) return target;
  return apply(deps, {
    spaceId: run.spaceId,
    botId: target.botId,
    userId: run.userId,
    threadId: target.threadId,
    ...(target.groupThreadId ? { scopeThreadId: target.groupThreadId } : {}),
    ...scheduleUpdateInput(args),
  });
}

/** Arguments the comparison cannot represent faithfully keep the generic approval card. */
const PLAIN_CARD_FIELDS = ["delayMinutes", "delaySeconds", "on", "everyMinutes", "endAt"];

/** The stored name and prompt an approval of a routine edit pins, each for a field the call writes. */
type RoutineBaseline = { name?: string; prompt?: string };

/**
 * The changes a card can show as they will be saved. The save takes the next run from its own
 * clock, as a resumed routine's and a repeating schedule's first occurrence are, unless the call
 * fixes it: an absolute time, a first start, or a pause that clears it.
 */
function cardChanges(
  changes: Record<string, { before: unknown; after: unknown }>,
  args: Record<string, unknown>,
) {
  const { nextRun, ...shown } = changes;
  // A pause is already shown as a status change.
  if (changes.active?.after === false && nextRun?.after === null) return shown;
  const fixed =
    nextRun?.after == null ||
    isScheduleValueProvided(args.runAt) ||
    isScheduleValueProvided(args.startAt);
  return fixed ? changes : shown;
}

/**
 * A schedule_update before the approval gate, answered by the save's own checks: the error that
 * ends the call with no card, or the baseline the approved call replays with and the card to show
 * beside the call's own arguments. The baseline is the routine's name and prompt as the preview
 * read them, for the fields the call writes, whatever the card: an edit that rewrites one is
 * answered, not saved over a newer one. The card shows a change as the save will make it. A
 * call it cannot show whole keeps the plain card: a delay is counted from the clock when the
 * approved call runs, events and a watch's interval are each one whole argument, and a change too
 * long for the card once redacted would lose its tail.
 */
export async function scheduleUpdatePreview(
  ctx: RunContext,
  args: Record<string, unknown>,
): Promise<{ error: string } | { summary?: FleetCardSummary; pinned?: RoutineBaseline }> {
  const planned = await onScheduleUpdateCall(ctx, args, (deps, input) =>
    updateScheduleFromTool(deps, input, { preview: true }),
  );
  if ("error" in planned) return planned;
  // The routine as the preview read it. A field the call rewrites is in `changes` with its stored
  // value; one it writes unchanged is not, and then holds what the call sent.
  const { changes } = planned;
  const storedName = typeof changes.name?.before === "string" ? changes.name.before : planned.name;
  const pinned: RoutineBaseline = {
    ...(isScheduleValueProvided(args.name) ? { name: storedName } : {}),
    ...(isScheduleValueProvided(args.prompt)
      ? {
          prompt:
            typeof changes.prompt?.before === "string"
              ? changes.prompt.before
              : String(args.prompt).trim(),
        }
      : {}),
  };
  const plain = Object.keys(pinned).length ? { pinned } : {};
  if (PLAIN_CARD_FIELDS.some((field) => isScheduleValueProvided(args[field]))) return plain;
  const { secrets } = ctx;
  const review = routineApprovalChanges(cardChanges(changes, args), secrets);
  if (review.length === 0) return plain;
  const lines = routineApprovalLines(review);
  // With room for a review reason of the longest allowed length leading the detail.
  const room = approvalDetailLength("schedule_update") - MAX_APPROVAL_SUMMARY_LENGTH - 2;
  if (lines.join("\n").length > room) return plain;
  return {
    ...plain,
    summary: {
      title: `Update “${cardName(redactSecrets(storedName, secrets))}”?`,
      lines,
      routineUpdate: { changes: review },
    },
  };
}
