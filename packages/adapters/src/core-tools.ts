import { readFileSync } from "node:fs";
import { getLogger } from "@rakazo/logging";
import defaultCoreTools from "../config/core-tools.json" with { type: "json" };
import { BUILTIN_AGENT_TOOL_NAMES } from "./run-tool-selection.js";

/**
 * Built-in tools the model always sees with full schemas. The list lives in
 * config/core-tools.json (shipped in the bundle); RAKAZO_CORE_TOOLS_CONFIG points at a file
 * of the same shape that replaces it for the whole process. find_tool and use_tool stay
 * listed even when a file omits them, and unknown names are skipped instead of crashing.
 */
export const FIND_TOOL = "find_tool";
export const USE_TOOL = "use_tool";

/** JSON file whose "core" array replaces the shipped default. */
export const CORE_TOOLS_ENV = "RAKAZO_CORE_TOOLS_CONFIG";

const BRIDGE_TOOLS = new Set([FIND_TOOL, USE_TOOL]);

/**
 * Last resort when no tool list file is usable. It mirrors the shipped default, so a broken
 * override never changes which tools a run gets.
 */
const FALLBACK_CORE_TOOL_NAMES = [
  "shell",
  "user_computer_shell",
  "read_file",
  "write_file",
  "list_files",
  "attach_file",
  "create_page",
  "web_search",
  "web_fetch",
  "service_search",
  "service_call",
  "computer_observe",
  "computer_act",
  "browser_navigate",
  "browser_snapshot",
  "browser_act",
  "ask_user",
  "message_user",
  "request_takeover",
  "request_secret",
  "connect_app",
  "run_subagent",
  "skill_read",
  "update_bot",
  "update_preferences",
  "remember",
  "save_memory",
  "recall_memory",
  "schedule_create",
  "schedule_list",
  "search_history",
  "read_history",
  "read_email",
  "send_email",
  "end_call",
];

export type CoreToolsSource = "default" | "override" | "fallback";

export interface CoreToolNames {
  /** The names the model always sees, including the bridge tools. */
  names: ReadonlySet<string>;
  /** Where the list came from. */
  source: CoreToolsSource;
  /** The file read, for overrides and the fallback after an unreadable one. */
  file?: string;
}

function coreListFromFile(raw: unknown): readonly string[] {
  if (typeof raw !== "object" || raw === null || !Array.isArray((raw as { core?: unknown }).core))
    throw new Error('the core tools file must be an object with a "core" array of tool names');
  return (raw as { core: readonly string[] }).core;
}

/**
 * Resolves the core list: the override file if RAKAZO_CORE_TOOLS_CONFIG is set, the shipped
 * default otherwise, and the built-in list when a file is unreadable or malformed.
 */
export function loadCoreToolNames(env: NodeJS.ProcessEnv = process.env): CoreToolNames {
  const override = env[CORE_TOOLS_ENV]?.trim() || undefined;
  let file: string | undefined;
  let list: readonly string[] | undefined;
  if (override) {
    file = override;
    try {
      list = coreListFromFile(JSON.parse(readFileSync(override, "utf8")));
    } catch (error) {
      getLogger().error(
        "core tools override is unreadable or malformed; using the built-in list",
        error,
        { "core.tools.file": override },
      );
    }
  } else {
    try {
      list = coreListFromFile(defaultCoreTools);
    } catch (error) {
      getLogger().error("shipped core tools list is malformed; using the built-in list", error);
    }
  }
  return normalizeCoreToolNames(
    list ?? FALLBACK_CORE_TOOL_NAMES,
    list ? (override ? "override" : "default") : "fallback",
    file,
  );
}

function normalizeCoreToolNames(
  list: readonly string[],
  source: CoreToolsSource,
  file: string | undefined,
): CoreToolNames {
  const warnings: string[] = [];
  const names = new Set<string>();
  for (const entry of list) {
    const name = typeof entry === "string" ? entry.trim() : "";
    if (!name) {
      warnings.push(`skipped core entry ${JSON.stringify(entry)}`);
      continue;
    }
    if (!BUILTIN_AGENT_TOOL_NAMES.has(name) && !BRIDGE_TOOLS.has(name)) {
      warnings.push(`skipped unknown core tool ${name}`);
      continue;
    }
    names.add(name);
  }
  // The bridge only exists while both are listed; a file may not remove them.
  for (const tool of [FIND_TOOL, USE_TOOL]) {
    if (!names.has(tool)) {
      names.add(tool);
      warnings.push(`added protected tool ${tool}`);
    }
  }
  getLogger().info("core tools loaded", {
    "core.tools.source": source,
    ...(file ? { "core.tools.file": file } : {}),
    "core.tools.count": names.size,
    "core.tools.names": [...names].sort(),
    ...(warnings.length ? { "core.tools.warnings": warnings } : {}),
  });
  return { names, source, ...(file ? { file } : {}) };
}

let loaded: CoreToolNames | undefined;

/** The resolved core tools, loaded once per process so a restart picks up file changes. */
export function coreBuiltinToolNames(): CoreToolNames {
  if (loaded === undefined) loaded = loadCoreToolNames();
  return loaded;
}
