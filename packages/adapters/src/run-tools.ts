import type { AgentToolExecutionObserver } from "@rakazo/adapter-kit";
import { toolResultTaintsRun } from "@rakazo/core";
import { IMAGE_RETURNING_COMPUTER_TOOLS, MODEL_CANNOT_SEE_MESSAGE } from "./model-vision.js";
import type { RunContext } from "./run-context.js";
import type { ToolHandler } from "./run-tool-gate.js";
import { gateToolCall } from "./run-tool-gate.js";
import { prepareToolRequest, resolveToolRequest } from "./run-tool-request.js";
import { PAGE_BROWSER_TOOL_NAMES } from "./run-tool-selection.js";
import { computerTools, pageBrowserTool } from "./run-tools-computer.js";
import { fileTools } from "./run-tools-files.js";
import { fleetTools } from "./run-tools-fleet.js";
import { cloudAgentTool, connectorTool, integrationTools } from "./run-tools-integrations.js";
import { memoryTools } from "./run-tools-memory.js";
import { messagingTools } from "./run-tools-messaging.js";
import { purchaseTools } from "./run-tools-purchases.js";
import { secretTools } from "./run-tools-secrets.js";
import { taskTools } from "./run-tools-tasks.js";
import { USER_COMPUTER_SHELL_TOOL, userComputerShell } from "./run-tools-user-computer.js";
import { argumentGiven } from "./update-bot-patch.js";

const TOOL_HANDLERS = new Map<string, ToolHandler>([
  ...Object.entries(computerTools),
  ...Object.entries(fileTools),
  ...Object.entries(memoryTools),
  ...Object.entries(integrationTools),
  ...Object.entries(taskTools),
  ...Object.entries(messagingTools),
  ...Object.entries(secretTools),
  ...Object.entries(fleetTools),
  [USER_COMPUTER_SHELL_TOOL, userComputerShell],
  ...Object.entries(purchaseTools),
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
  try {
    return await dispatchTool(ctx, name, args, executionId, observer);
  } finally {
    // Editing its own profile returns only what this run wrote; a child's profile is another bot's.
    const ownProfile = name === "update_bot" && !argumentGiven(args.bot_id);
    if (toolResultTaintsRun(name) && !ownProfile) ctx.state.tainted = true;
  }
}

async function dispatchTool(
  ctx: RunContext,
  name: string,
  args: Record<string, unknown>,
  executionId: string,
  observer: AgentToolExecutionObserver | undefined,
) {
  ctx.context.signal.throwIfAborted();
  if (ctx.state.handedOff) {
    return {
      error: "This stage was handed off. End the turn without more tool calls.",
    };
  }
  if (ctx.tools.disabled.has(name)) {
    return { error: "This tool is disabled for this bot." };
  }
  if (PAGE_BROWSER_TOOL_NAMES.has(name) && !ctx.computer.pageBrowserAllowed) {
    return { error: "Page browser is unavailable on this computer." };
  }
  if (IMAGE_RETURNING_COMPUTER_TOOLS.has(name) && !ctx.computer.acceptsImages) {
    return { error: MODEL_CANNOT_SEE_MESSAGE };
  }
  const request = await resolveToolRequest(ctx, name, args, executionId);
  if ("error" in request) return request;
  const refused = await prepareToolRequest(ctx, request);
  if (refused) return refused;
  const gate = await gateToolCall(ctx, request, observer);
  if ("result" in gate) return gate.result;
  return toolHandler(gate.call.name)(ctx, gate.call);
}
