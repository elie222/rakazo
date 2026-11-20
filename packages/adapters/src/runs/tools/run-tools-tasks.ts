import type { FleetCardSummary } from "../../approvals/approval-ask.js";
import {
  desktopGuardApplies,
  desktopProtectionGuardMessage,
  protectedComputerLifecycleRefusal,
} from "../../providers/computer/desktop/desktop-command-guard.js";
import { routineEventsView } from "../../routines/routine-triggers.js";
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
import {
  cancelScheduleFromTool,
  commandWatchFromTool,
  compactScheduleInput,
  createScheduleFromTool,
  isScheduleValueProvided,
  listSchedulesFromTool,
  planScheduleUpdate,
  scheduleCreateError,
  scheduleCreateFields,
  scheduleTimingArgs,
  updateScheduleFromTool,
} from "../../tools/schedule-tools.js";
import {
  routineAfterView,
  routineChanges,
  routineChangesDiffLines,
  routineViewOf,
} from "../../tools/schedule-update-view.js";
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
  return desktopGuardApplies(ctx.computer) && refusal
    ? desktopProtectionGuardMessage(refusal, command ?? "")
    : undefined;
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

/** A schedule_update call's fields, mapped the same way for the handler and the approval card. */
function scheduleUpdateInput(
  thread: { id: string; groupId: string | null },
  args: Record<string, unknown>,
) {
  const expected = args.expected as { name?: unknown; prompt?: unknown } | undefined;
  const expectedName = typeof expected?.name === "string" ? expected.name : undefined;
  const expectedPrompt = typeof expected?.prompt === "string" ? expected.prompt : undefined;
  return {
    ...(thread.groupId ? { scopeThreadId: thread.id } : {}),
    routineId: String(args.routineId ?? ""),
    name: isScheduleValueProvided(args.name) ? String(args.name) : undefined,
    prompt: isScheduleValueProvided(args.prompt) ? String(args.prompt) : undefined,
    inChat: typeof args.inChat === "boolean" ? args.inChat : undefined,
    active: typeof args.active === "boolean" ? args.active : undefined,
    timezone: isScheduleValueProvided(args.timezone) ? String(args.timezone) : undefined,
    schedule: compactScheduleInput(scheduleTimingArgs(args)),
    on: isScheduleValueProvided(args.on) ? args.on : undefined,
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

/** How much of a replaced prompt's old text a card shows before clipping it. */
const CARD_BEFORE_PROMPT_MAX = 800;

/**
 * The approval card for a schedule_update: the routine's current values against what the call
 * changes, as diff lines. Read from the row the handler will change, so the card shows the
 * exact change; a call that cannot resolve shows no card of its own and the handler errors.
 *
 * The canonical args pin the row's name and prompt as `expected` — the baseline the handler
 * conflicts against when the row moves before an approved call runs. Timing passes through
 * unchanged, so a relative delay resolves when the handler runs, exactly as it would without
 * the card.
 */
export async function scheduleUpdateCardSummary(
  ctx: RunContext,
  args: Record<string, unknown>,
): Promise<
  | { summary: FleetCardSummary; canonical: Record<string, unknown> }
  | { canonical: Record<string, unknown> }
  | undefined
> {
  const { deps, run, bot, thread } = ctx;
  // The caller strips any model-supplied baseline before reading the row; `given` is that call.
  const given = args;
  const input = scheduleUpdateInput(thread, given);
  const existing = await deps.prisma.routine.findFirst({
    where: {
      spaceId: run.spaceId,
      botId: bot.id,
      ...(thread.groupId ? { threadId: thread.id } : {}),
      id: input.routineId.trim(),
      bot: { archivedAt: null },
    },
  });
  if (!existing) return undefined;
  const planned = planScheduleUpdate(existing, input);
  if (!planned.ok) return undefined;
  const expected = {
    ...(input.name !== undefined ? { name: existing.name } : {}),
    ...(input.prompt !== undefined ? { prompt: existing.prompt } : {}),
  };
  const canonical = {
    ...given,
    ...(Object.keys(expected).length ? { expected } : {}),
  };
  // Events the call replaces are validated against the database when the handler runs, so a
  // change that replaces them shows the plain card instead of a diff the card cannot know;
  // the pinned before-values still cover the text fields the call writes.
  if (given.on !== undefined) return { canonical };
  const changes = routineChanges(
    routineViewOf(existing),
    routineAfterView(existing, planned.plan, routineEventsView(existing)),
  );
  // A name's own line breaks and Markdown punctuation must not reach the card title.
  const title = cardName(existing.name);
  // The old prompt alone must not crowd the new text off the card, so the card clips it.
  const promptBefore = changes.prompt?.before;
  const shown =
    typeof promptBefore === "string" && promptBefore.length > CARD_BEFORE_PROMPT_MAX
      ? {
          ...changes,
          prompt: {
            before: `${promptBefore.slice(0, CARD_BEFORE_PROMPT_MAX)}…`,
            after: changes.prompt?.after,
          },
        }
      : changes;
  return {
    summary: { title: `Update routine “${title}”?`, lines: routineChangesDiffLines(shown) },
    canonical,
  };
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
    const { deps, run, bot, thread } = ctx;
    const { args } = call;
    return call.finish(
      await updateScheduleFromTool(deps, {
        spaceId: run.spaceId,
        botId: bot.id,
        userId: run.userId,
        threadId: thread.id,
        ...scheduleUpdateInput(thread, args),
      }),
    );
  },
  async schedule_list(ctx) {
    const { deps, run, bot, thread } = ctx;
    return listSchedulesFromTool(deps, {
      spaceId: run.spaceId,
      botId: bot.id,
      ...(thread.groupId ? { groupThreadId: thread.id } : {}),
    });
  },
  async schedule_cancel(ctx, call) {
    const { deps, run, bot, thread } = ctx;
    const { args } = call;
    const cancelled = await cancelScheduleFromTool(deps, {
      spaceId: run.spaceId,
      botId: bot.id,
      ...(thread.groupId ? { threadId: thread.id } : {}),
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
