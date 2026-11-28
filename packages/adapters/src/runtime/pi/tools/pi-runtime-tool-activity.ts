import type { ConnectorTool } from "@rakazo/adapter-kit";
import { batchActions, humanizeToolName } from "@rakazo/core";
import { FIND_TOOL, USE_TOOL } from "../../../tools/builtin.tool-definition.js";
import { sanitizeSensitiveText } from "../pi-runtime-errors.js";
import { clipToolResultText } from "../pi-runtime-limits.js";

const ACTIVITY_DETAIL_LIMIT = 90;

const MAX_STEP_ACTIONS = 3;
const STEP_ACTION_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/**
 * What a call's steps show: the actions a batch runs, else the tool's label. Empty when neither
 * applies, so callers fall back to the tool name.
 */
export function connectorStepNames(tool: ConnectorTool | undefined, args: unknown): string[] {
  const actions = batchStepActions(tool, args);
  if (actions.length > 0) return actions;
  return tool?.label ? [tool.label] : [];
}

/** The model writes these names, so show only a few that look like tool names. */
function batchStepActions(tool: ConnectorTool | undefined, args: unknown): string[] {
  if (!tool?.batch) return [];
  const { actions, complete } = batchActions(tool.batch, args);
  if (!complete || actions.length > MAX_STEP_ACTIONS) return [];
  if (!actions.every((action) => STEP_ACTION_NAME.test(action))) return [];
  return actions.map(humanizeToolName);
}

/** One human-readable line describing a tool call, shown live in the thread. */
export function describeToolActivity(
  toolName: string,
  args: unknown,
  findTool?: (name: string) => ConnectorTool | undefined,
): string {
  const record = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  if (toolName === USE_TOOL)
    return describeToolActivity(String(record.name), record.arguments, findTool);
  const tool = findTool?.(toolName);
  const actions = batchStepActions(tool, args);
  if (actions.length > 0) return `Using ${actions.join(", ")}`;
  if (tool?.label) return tool.label;
  if (toolName === FIND_TOOL) return "Finding a tool";
  const detail = (value: unknown): string => {
    const text = sanitizeSensitiveText(String(value ?? ""))
      .replaceAll(/\s+/g, " ")
      .trim();
    return clipToolResultText(text, ACTIVITY_DETAIL_LIMIT);
  };
  if (toolName === "shell") return `Running: ${detail(record.command)}`;
  if (toolName === "user_computer_shell")
    return `Running on your computer: ${detail(record.command)}`;
  if (toolName === "user_computer_observe") return `Looking at ${detail(record.app)}`;
  if (toolName === "user_computer_act") return `Using ${detail(record.app)}`;
  if (toolName === "read_file") return `Reading ${detail(record.path)}`;
  if (toolName === "write_file") return `Writing ${detail(record.path)}`;
  if (toolName === "list_files") return `Listing ${detail(record.path ?? ".")}`;
  if (toolName === "attach_file") return `Attaching ${detail(record.path)}`;
  if (toolName === "open_path") return `Opening ${detail(record.path)}`;
  if (toolName === "render_plot") return "Rendering a chart";
  if (toolName === "save_page") {
    if (record.help === true) return "Reading the page kit reference";
    return record.list === true ? "Checking your pages" : "Writing the page code";
  }
  if (toolName === "add_mcp_server") return `Connecting MCP server: ${detail(record.name)}`;
  if (toolName === "remove_mcp_server") return `Removing MCP server: ${detail(record.name)}`;
  if (toolName === "computer_observe") return "Looking at the screen";
  if (toolName === "browser_navigate")
    return `Opening page: ${detail(redactActivityUrl(record.url))}`;
  if (toolName === "browser_snapshot") return "Reading the page";
  if (toolName === "browser_act") return "Using the page";
  if (toolName === "computer_act") return "Operating the computer";
  if (toolName === "run_subagent") return `Delegating to helper: ${detail(record.name)}`;
  if (toolName === "list_subagents") return "Checking running subagents";
  if (toolName === "cancel_subagent") {
    if (record.all === true) return "Stopping all subagents";
    const target = detail(record.name ?? record.id);
    return target ? `Stopping subagent: ${target}` : "Stopping subagent";
  }
  if (toolName === "create_space") return `Creating space: ${detail(record.name)}`;
  if (toolName === "list_fleet") return "Checking your bots";
  if (toolName === "create_group") return `Creating group: ${detail(record.name)}`;
  if (toolName === "update_group")
    return `Updating group: ${detail(record.group_name ?? record.name)}`;
  if (toolName === "organize_bot") return "Organizing the sidebar";
  if (toolName === "set_child_instructions") return "Rewriting a bot's instructions";
  if (toolName === "set_child_bot_model") return "Setting a bot's model";
  if (toolName === "create_child_routine") return `Scheduling routine: ${detail(record.name)}`;
  if (toolName === "remember") return "Saving a note to memory";
  if (toolName === "delete_shared_memory") return `Deleting shared memory: ${detail(record.path)}`;
  if (toolName === "web_search") return `Searching the web: ${detail(record.query)}`;
  if (toolName === "web_fetch") return `Reading page: ${detail(redactActivityUrl(record.url))}`;
  if (toolName === "service_search") return `Finding a service: ${detail(record.query)}`;
  if (toolName === "service_call") return `Using service: ${detail(record.service)}`;
  if (toolName === "skill_read")
    return record.file
      ? `Reading ${detail(record.file)} from ${detail(record.name)}`
      : `Reading skill: ${detail(record.name)}`;
  if (toolName === "skill_create") return `Creating skill: ${detail(record.name ?? "skill")}`;
  if (toolName === "skill_update")
    return `Updating skill: ${detail(record.name ?? record.skillId)}`;
  if (toolName === "skill_delete")
    return `Deleting skill: ${detail(record.name ?? record.skillId)}`;
  const mcp = toolName.match(/^mcp__(.+?)__(.+)$/);
  if (mcp) return `Using ${mcp[1]}: ${mcp[2]}`;
  return `Using ${toolName}`;
}

/** Origin + path only for activity chips; drop userinfo, query, and fragment. */
function redactActivityUrl(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) return raw;
  try {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    // Never echo unparsed input — it may still contain userinfo/secrets.
    return "[invalid URL]";
  }
}
