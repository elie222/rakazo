import type { AgentTool } from "@earendil-works/pi-agent-core";
import { narrationStatusLine } from "../../../runs/lifecycle/user-progress.js";
import { USE_TOOL } from "../../../tools/builtin.tool-definition.js";
import { sanitizeSensitiveText } from "../pi-runtime-errors.js";
import type { ToolHost } from "./pi-runtime-tools.js";
import { STEP_STATUS_DESCRIPTION, STEP_STATUS_FIELD } from "./step-status.tool-definition.js";

/**
 * On a run told to narrate live, offers the model the `live_status` field on a tool and records the
 * tool as narrated. Only a field this runtime added is read as a status; a tool's own `status`
 * argument is the tool's business.
 */
export function withStepStatus(agentTool: AgentTool, host: ToolHost, toolName: string): AgentTool {
  if (!host.request.narratesLive || STATUSLESS_TOOLS.has(toolName)) return agentTool;
  const narrated = withStepStatusField(agentTool);
  if (narrated !== agentTool) {
    host.narratedTools ??= new Set();
    host.narratedTools.add(agentTool.name);
  }
  return narrated;
}

/** Tools whose own text is what the person reads, so a status line would only repeat it. */
const STATUSLESS_TOOLS = new Set(["message_user", "ask_user", "request_secret"]);

/**
 * Offers the model a `live_status` field on the tool, the line the thread shows while the call runs.
 * It is taken out before the tool's own argument handling, so the tool never sees it.
 */
function withStepStatusField(agentTool: AgentTool): AgentTool {
  const schema = agentTool.parameters as unknown as {
    type?: unknown;
    properties?: Record<string, unknown>;
  };
  // A free-form object tool, with no properties listed, keeps its schema: a grammar-constrained
  // provider would read a lone `live_status` as the only key it may send, and the tool would
  // get no arguments.
  if (
    schema?.type !== "object" ||
    !schema.properties ||
    Object.keys(schema.properties).length === 0 ||
    STEP_STATUS_FIELD in schema.properties
  )
    return agentTool;
  schema.properties[STEP_STATUS_FIELD] = { type: "string", description: STEP_STATUS_DESCRIPTION };
  const prepare = agentTool.prepareArguments;
  return {
    ...agentTool,
    prepareArguments: (args: unknown) => {
      const rest = withoutStepStatus(args);
      return prepare ? prepare(rest) : rest;
    },
  };
}

function withoutStepStatus(args: unknown): unknown {
  if (!args || typeof args !== "object" || !(STEP_STATUS_FIELD in args)) return args;
  const { [STEP_STATUS_FIELD]: _status, ...rest } = args as Record<string, unknown>;
  return rest;
}

/**
 * The status the model gave a call, cleaned for the working line, when it gave one. Only tools
 * in `narrated` carry the added field; a `use_tool` call may carry it outside or, for a
 * narrated tool, inside its arguments.
 */
export function stepStatusOf(
  toolName: string,
  args: unknown,
  narrated: ReadonlySet<string> | undefined,
): string | undefined {
  if (!narrated?.has(toolName) || !args || typeof args !== "object") return undefined;
  const record = args as Record<string, unknown>;
  const value = record[STEP_STATUS_FIELD];
  const text =
    typeof value === "string" ? sanitizeSensitiveText(value).replaceAll(/\s+/g, " ").trim() : "";
  if (text) return narrationStatusLine(text);
  return toolName === USE_TOOL
    ? stepStatusOf(String(record.name), record.arguments, narrated)
    : undefined;
}

/** Remembers the status the model gave a call, by call id, for the step it becomes. */
export function rememberStepStatus(
  host: ToolHost,
  callId: string,
  toolName: string,
  args: unknown,
) {
  const status = stepStatusOf(toolName, args, host.narratedTools);
  // Calls without an id would share one key, and a concurrent one could take another's status.
  if (!callId) return status;
  if (status) {
    host.stepStatuses ??= new Map();
    host.stepStatuses.set(callId, status);
  } else host.stepStatuses?.delete(callId);
  return status;
}
