import type { AgentToolExecutionObserver } from "@rakazo/adapter-kit";
import { BACKGROUND_HELPER_TRIGGER, toolResultTaintsRun } from "@rakazo/core";
import {
  isInternalTermination,
  isTerminatingReplyResult,
} from "../../approvals/approval-effect.js";
import { argumentGiven } from "../../bots/update-bot-patch.js";
import { listChatTranscripts, readChatMeeting } from "../../meetings/meeting-chat.js";
import {
  meetingTranscriptArgs,
  READ_MEETING_TRANSCRIPT,
} from "../../meetings/meeting-chat.tool-definition.js";
import { IMAGE_RETURNING_COMPUTER_TOOLS } from "../../models/model-vision.js";
import { MODEL_CANNOT_SEE_MESSAGE } from "../../models/model-vision.prompt.js";
import { personalCalendarTools } from "../../personal-calendar/personal-calendar.tool-definition.js";
import { calendarTool } from "../../personal-calendar/run-calendar-tool.js";
import { strategicInitiativeToolAllowed } from "../../routines/strategic-initiative.js";
import type { RunContext } from "../assembly/run-context.js";
import { markReadOutsideContent } from "../assembly/run-context.js";
import { noteComputerTaskStep } from "../lifecycle/run-progress.js";
import { logToolRefusal } from "../turn/tool-completion-audit.js";
import { refusal } from "../turn/tool-refusal.js";
import { auditToolCall } from "./run-tool-audit.js";
import type { ToolHandler } from "./run-tool-gate.js";
import { gateToolCall } from "./run-tool-gate.js";
import { prepareToolRequest, resolveToolRequest } from "./run-tool-request.js";
import {
  BUILTIN_AGENT_TOOL_NAMES,
  PAGE_BROWSER_TOOL_NAMES,
  SUBAGENT_HIDDEN_TOOLS,
} from "./run-tool-selection.js";
import { computerTools, pageBrowserTool } from "./run-tools-computer.js";
import { emailTools } from "./run-tools-email.js";
import { feedbackTools } from "./run-tools-feedback.js";
import { fileTools } from "./run-tools-files.js";
import { fleetTools } from "./run-tools-fleet.js";
import { cloudAgentTool, connectorTool, integrationTools } from "./run-tools-integrations.js";
import { memoryTools } from "./run-tools-memory.js";
import { messagingTools } from "./run-tools-messaging.js";
import { pageTools } from "./run-tools-pages.js";
import { preferenceTools } from "./run-tools-preferences.js";
import { purchaseTools } from "./run-tools-purchases.js";
import { secretTools } from "./run-tools-secrets.js";
import { taskTools } from "./run-tools-tasks.js";
import { topicTools } from "./run-tools-topics.js";
import {
  USER_COMPUTER_ACT_TOOL,
  USER_COMPUTER_OBSERVE_TOOL,
  USER_COMPUTER_SHELL_TOOL,
  USER_COMPUTER_TOOLS,
  userComputerAct,
  userComputerList,
  userComputerObserve,
  userComputerShell,
} from "./run-tools-user-computer.js";

/** The owner's own computer: its shell, screen and computer list. */
const ownComputerResult = (tool: string) =>
  USER_COMPUTER_TOOLS.has(tool) || tool === "user_computer_list";

const TOOL_HANDLERS = new Map<string, ToolHandler>([
  ...Object.entries(computerTools),
  ...Object.entries(fileTools),
  ...Object.entries(pageTools),
  ...Object.entries(memoryTools),
  [
    READ_MEETING_TRANSCRIPT,
    async (ctx, call) => {
      const input = meetingTranscriptArgs.safeParse(call.args);
      if (!input.success || !ctx.source.meetingChat || (await ctx.trust.receivedOutsideMessage())) {
        return call.finish({ error: "A meeting in this bot’s chat is required." });
      }
      const { meeting_id, offset, before } = input.data;
      if (!meeting_id)
        return call.finish(await listChatTranscripts(ctx.deps.prisma, ctx.run, before));
      const transcript = await readChatMeeting(ctx.deps.prisma, ctx.run, meeting_id, offset);
      return call.finish(transcript ?? { error: "The meeting transcript is unavailable." });
    },
  ],
  ...Object.entries(integrationTools),
  ...Object.entries(taskTools),
  ...Object.entries(topicTools),
  ...Object.entries(messagingTools),
  ...Object.entries(secretTools),
  ...Object.entries(fleetTools),
  ["user_computer_list", userComputerList],
  [USER_COMPUTER_SHELL_TOOL, userComputerShell],
  [USER_COMPUTER_OBSERVE_TOOL, userComputerObserve],
  [USER_COMPUTER_ACT_TOOL, userComputerAct],
  ...Object.entries(purchaseTools),
  ...Object.entries(preferenceTools),
  ...Object.entries(feedbackTools),
  ...Object.entries(emailTools),
  ...personalCalendarTools.map(({ name }) => [name, calendarTool] as const),
  ...[...PAGE_BROWSER_TOOL_NAMES].map((name) => [name, pageBrowserTool] as const),
]);

function toolHandler(name: string): ToolHandler {
  return (
    TOOL_HANDLERS.get(name) ?? (name.startsWith("cloud_agent_") ? cloudAgentTool : connectorTool)
  );
}

/** Run one tool call of this run's model: gate it, then hand it to its tool family. */
export async function applyTool(
  ctx: RunContext,
  name: string,
  args: Record<string, unknown>,
  executionId: string,
  _route?: unknown,
  observer?: AgentToolExecutionObserver,
) {
  // Refused there: a routine with its owner's computer is never offered update_bot.
  if (ctx.source.ownerComputerRoutine) return dispatchTool(ctx, name, args, executionId, observer);
  // A bot naming itself in bot_id means its own settings. Dropping it here sends the call down
  // the own path everywhere: preparation, the stored approval, the handler and its taint check.
  if (
    name === "update_bot" &&
    typeof args.bot_id === "string" &&
    args.bot_id.trim() === ctx.bot.id
  ) {
    const { bot_id: _self, ...own } = args;
    args = own;
  }
  if (name === "update_bot" && ownFieldsBesideInstructions(args).length)
    return applyOwnUpdateWithInstructions(ctx, args, executionId, observer);
  return dispatchTool(ctx, name, args, executionId, observer);
}

/** The other fields an own update_bot call changes along with its instructions, if it does. */
function ownFieldsBesideInstructions(args: Record<string, unknown>): string[] {
  const { instructions, instructions_offset, instructionsOffset, bot_id, ...rest } = args;
  if (
    argumentGiven(bot_id) ||
    !argumentGiven(instructions) ||
    // Zero is the default offset, which the update drops, so only a later page makes this a read.
    ((instructions_offset ?? instructionsOffset) !== 0 &&
      argumentGiven(instructions_offset ?? instructionsOffset))
  )
    return [];
  // Only the gate sets these; a model sending them is ignored.
  const { previousInstructions, previousInstructionsFromBaseline, reason, ...fields } = rest;
  return Object.keys(fields).filter((key) => argumentGiven(fields[key]));
}

/**
 * An own update_bot call that changes instructions along with other fields runs as two calls:
 * the other fields first, as they would alone, then the instructions, which may be held for
 * approval. An approval therefore only ever covers the instructions it shows.
 */
async function applyOwnUpdateWithInstructions(
  ctx: RunContext,
  args: Record<string, unknown>,
  executionId: string,
  observer: AgentToolExecutionObserver | undefined,
) {
  const others = ownFieldsBesideInstructions(args);
  const { approvedReplays } = ctx.tools;
  // Resuming after the instructions were approved: the other fields were saved before they
  // were held, so only the instructions replay.
  const resumingInstructions =
    approvedReplays.nextToolName() === "update_bot" &&
    typeof (approvedReplays.nextRequest() as { previousInstructions?: unknown } | undefined)
      ?.previousInstructions === "string";
  const profile = resumingInstructions
    ? undefined
    : await dispatchTool(
        ctx,
        "update_bot",
        Object.fromEntries(others.map((key) => [key, args[key]])),
        executionId,
        observer,
      );
  if (profile && isInternalTermination(profile)) return profile;
  if (profile && isToolError(profile))
    return { error: `${errorText(profile)} Your instructions were not saved either.` };
  const set = await dispatchTool(
    ctx,
    "update_bot",
    { instructions: args.instructions },
    executionId,
    observer,
  );
  if (isInternalTermination(set)) return set;
  // A profile part that only repeated current values was answered as a read; it saved nothing.
  // When resuming, it was saved before the instructions were held.
  const changed =
    profile && "ok" in (profile as object) ? (profile as Record<string, unknown>) : {};
  const saved = !profile || "ok" in changed ? others : [];
  if (isToolError(set))
    return {
      error: `${saved.length ? `Your ${saved.join(", ")} changes were saved, but your instructions were not: ` : ""}${errorText(set)}`,
    };
  return { ...changed, ...(set as Record<string, unknown>), saved: [...saved, "instructions"] };
}

function errorText(result: unknown): string {
  const error = (result as { error?: unknown }).error;
  return typeof error === "string" ? error : "it was refused.";
}

async function dispatchTool(
  ctx: RunContext,
  name: string,
  args: Record<string, unknown>,
  executionId: string,
  observer: AgentToolExecutionObserver | undefined,
) {
  ctx.context.signal.throwIfAborted();
  // A call turned away before its tool runs is logged by its refusal code. `target` is the
  // connector tool a catalog call resolved to.
  const refuse = <T>(refused: T, target?: string): T => {
    const logged = logToolRefusal(
      {
        spaceId: ctx.run.spaceId,
        threadId: ctx.thread.id,
        botId: ctx.bot.id,
        runId: ctx.runId,
        trigger: ctx.run.trigger,
      },
      name,
      refused,
      ctx.secrets,
      target === name ? undefined : target,
    );
    if (logged) {
      ctx.state.toolRefusals ??= new Map();
      ctx.state.toolRefusals.set(executionId, logged);
    }
    return refused;
  };
  if (!strategicInitiativeToolAllowed(name, ctx.run)) {
    return refuse(
      refusal(
        "daily_check_in_tool_not_allowed",
        "Daily check-ins can only ask the user. Put any reminder in your final reply.",
      ),
    );
  }
  if (ctx.state.handedOff) {
    return refuse(
      refusal(
        "stage_handed_off",
        "This stage was handed off. End the turn without more tool calls.",
      ),
    );
  }
  if (ctx.tools.disabled.has(name)) {
    return refuse(refusal("tool_disabled", "This tool is disabled for this bot."));
  }
  // A routine with its owner's computer may run only what it was offered, whatever name the
  // runtime emits. It is offered no catalog or connector tool, so no call of its remaps either.
  if (ctx.source.ownerComputerRoutine && !ctx.tools.offered.some((tool) => tool.name === name)) {
    return refuse(refusal("tool_not_offered", `${name} is not available in this run.`));
  }
  // Only offered tools reach the model, but a runtime can still emit any name, and a connector
  // tool named like a local one still runs the local handler.
  if (
    ctx.run.trigger === BACKGROUND_HELPER_TRIGGER &&
    (BUILTIN_AGENT_TOOL_NAMES.has(name) || TOOL_HANDLERS.has(name)) &&
    (SUBAGENT_HIDDEN_TOOLS.has(name) || !ctx.tools.builtins.some((tool) => tool.name === name))
  ) {
    return refuse(
      refusal(
        "helper_tool_unavailable",
        `${name} is not available to a subagent. Say in your result what the parent should do.`,
      ),
    );
  }
  if (Object.hasOwn(memoryTools, name) && !ctx.tools.offered.some((tool) => tool.name === name)) {
    return refuse(
      refusal("memory_tool_unavailable", "This memory tool is unavailable in this run."),
    );
  }
  if (PAGE_BROWSER_TOOL_NAMES.has(name) && !ctx.computer.pageBrowserAllowed) {
    return refuse(
      refusal("page_browser_unavailable", "Page browser is unavailable on this computer."),
    );
  }
  if (IMAGE_RETURNING_COMPUTER_TOOLS.has(name) && !ctx.computer.acceptsImages) {
    return refuse(refusal("model_cannot_see_images", MODEL_CANNOT_SEE_MESSAGE));
  }
  const request = await resolveToolRequest(ctx, name, args, executionId);
  if ("error" in request) return refuse(request);
  // A catalog call resolves to a connector tool after the checks above; one named like a local
  // tool (message_agent, cloud_agent_*, ...) would otherwise run that local handler instead.
  if (request.catalogRemapped && toolHandler(request.name) !== connectorTool) {
    return refuse(
      refusal("connector_name_conflict", "Connector tool name conflicts with a built-in tool"),
      request.name,
    );
  }
  const refused = await prepareToolRequest(ctx, request);
  if (refused) return refuse(refused, request.name);
  noteComputerTaskStep(ctx.state.reply, request.name);
  const gate = await gateToolCall(ctx, request, observer);
  if ("result" in gate) {
    const ownProfile = name === "update_bot" && !argumentGiven(args.bot_id);
    if (gate.replayed && toolResultTaintsRun(request.name) && !ownProfile) {
      await markReadOutsideContent(ctx, gate.result, {
        ownComputer: ownComputerResult(request.name),
      });
    }
    return refuse(gate.result, request.name);
  }
  // Only a call that ran can have taken in outside content; one refused above, or whose approval
  // was denied, never did. A call that failed partway still counts.
  const runHandler = async () => {
    let result: unknown;
    try {
      result = await toolHandler(gate.call.name)(ctx, gate.call);
      return result;
    } finally {
      // Editing its own profile returns only what this run wrote; a child's profile is another
      // bot's.
      const ownProfile = name === "update_bot" && !argumentGiven(args.bot_id);
      if (toolResultTaintsRun(name) && !ownProfile)
        await markReadOutsideContent(ctx, result, { ownComputer: ownComputerResult(name) });
    }
  };
  if (!gate.call.applied) return runHandler();
  let outcome: "success" | "failure" = "failure";
  try {
    const result = await runHandler();
    if (!isToolError(result)) outcome = "success";
    return result;
  } finally {
    const route = gate.call.connectorCall.route;
    await auditToolCall(ctx, gate.call.name, outcome, {
      effectId: gate.call.applied.effect.id,
      autoApproved: gate.call.bypassApproval,
      ...(route?.connectionId && {
        connectorId: route.connectorId,
        connectionId: route.connectionId,
      }),
    });
  }
}

export function isToolError(result: unknown): boolean {
  if (typeof result !== "object" || result === null) return false;
  if ("error" in result) return true;
  return isTerminatingReplyResult(result);
}
