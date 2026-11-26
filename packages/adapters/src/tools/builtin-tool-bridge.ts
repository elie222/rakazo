import type { ConnectorTool, ToolSearchHit, ToolSearchRequest } from "@rakazo/adapter-kit";
import { FLEET_TOOL_NAMES } from "@rakazo/contracts";
import { READ_MEETING_TRANSCRIPT } from "../meetings/meeting-chat.tool-definition.js";
import { BUILTIN_AGENT_TOOL_NAMES } from "../runs/tools/run-tool-selection.js";
import { bridgeToolDefinitions } from "./builtin.tool-definition.js";
import type { CatalogEntry } from "./lazy-tool-catalog.js";
import {
  catalogEntries,
  formatNameIndexText,
  groupedNames,
  isLazyCatalogControlRoute,
  rankCatalogEntries,
} from "./lazy-tool-catalog.js";
import {
  FIND_TOOL_LIMIT,
  rankToolSearchHits,
  shownToolSearchHit,
} from "./tool-search/tool-search.js";

const FIND_TOOL_LIMIT_PER_SOURCE = 3;

/**
 * Built-in tools the model always sees with full schemas: everyday work, and every tool the
 * runtime answers itself. Other built-ins offered to a run are reached through find_tool and
 * use_tool, so the listed tools stay small and never change mid-run.
 */
export const CORE_BUILTIN_TOOL_NAMES: ReadonlySet<string> = new Set([
  "shell",
  "user_computer_list",
  "user_computer_shell",
  "read_file",
  "write_file",
  "list_files",
  "attach_file",
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
  "message_bot",
  "skill_read",
  "update_bot",
  "update_preferences",
  "remember",
  "save_memory",
  "recall_memory",
  "reflect_memory",
  "schedule_create",
  "schedule_list",
  "search_history",
  "read_history",
  READ_MEETING_TRANSCRIPT,
  "read_email",
  "send_email",
  "end_call",
]);

const FLEET_NAMES: ReadonlySet<string> = new Set(FLEET_TOOL_NAMES);

const AREAS: Array<[area: string, matches: (name: string) => boolean]> = [
  ["secrets", (name) => name.includes("secret")],
  ["bots", (name) => FLEET_NAMES.has(name) || name.endsWith("_bot") || name === "post_to_group"],
  [
    "tasks",
    (name) =>
      /^(scratchpad_|ticket_)/.test(name) || ["board_tickets", "task_catalog"].includes(name),
  ],
  ["skills", (name) => name.startsWith("skill_")],
  ["calendar", (name) => /calendar|reminder/.test(name)],
  ["schedules", (name) => name.startsWith("schedule_")],
  ["memory", (name) => name.includes("memory")],
  [
    "media",
    (name) => name.startsWith("generate_") || name === "render_plot" || name === "save_page",
  ],
  ["cloud agents", (name) => name.startsWith("cloud_agent_")],
  ["purchases", (name) => name.includes("purchase") || name === "paid_request"],
  ["email", (name) => name.includes("email")],
];

export function isDeferredTool(name: string): boolean {
  return BUILTIN_AGENT_TOOL_NAMES.has(name) && !CORE_BUILTIN_TOOL_NAMES.has(name);
}

/** Splits a run's offered tools into the ones listed to the model and the deferred built-ins. */
export function partitionTools(tools: readonly ConnectorTool[]): {
  listed: ConnectorTool[];
  deferred: ConnectorTool[];
} {
  const deferred = tools.filter((tool) => isDeferredTool(tool.name));
  const listed = tools.filter((tool) => !isDeferredTool(tool.name));
  return { listed: deferred.length ? [...listed, ...bridgeTools(deferred)] : listed, deferred };
}

function searchEntries(deferred: readonly ConnectorTool[]): CatalogEntry[] {
  return catalogEntries(
    deferred.map((tool) => ({
      ...tool,
      // Parameter names rank like description words.
      description: `${tool.description} ${Object.keys(
        (tool.inputSchema.properties as Record<string, unknown> | undefined) ?? {},
      ).join(" ")}`,
      route: {
        connectorId: "builtin",
        toolName: tool.name,
        catalogGroup: AREAS.find(([, matches]) => matches(tool.name))?.[0] ?? "other",
      },
    })),
  );
}

function bridgeTools(deferred: readonly ConnectorTool[]): ConnectorTool[] {
  return bridgeToolDefinitions(formatNameIndexText(groupedNames(searchEntries(deferred))));
}

/** Prototype-safe lookup for why a built-in tool was not offered to the run. */
export function unavailableToolReason(
  reasons: Readonly<Record<string, string>> | undefined,
  name: string,
): string | undefined {
  if (!reasons || !Object.hasOwn(reasons, name)) return undefined;
  const reason = reasons[name];
  return typeof reason === "string" && reason.length > 0 ? reason : undefined;
}

/** The deferred built-ins named, or the best matches for a query, as find_tool hits. */
export function findBuiltinTools(
  deferred: readonly ConnectorTool[],
  args: Record<string, unknown>,
): ToolSearchHit[] {
  const { names, query } = findArguments(args);
  const found = names.length
    ? deferred.filter((tool) => names.includes(tool.name))
    : query
      ? rankCatalogEntries(searchEntries(deferred), query, FIND_TOOL_LIMIT_PER_SOURCE).hits.map(
          (entry) => deferred.find((tool) => tool.name === entry.id)!,
        )
      : [];
  return found.map(toolHit);
}

/** Connector tools the run lists directly, which use_tool also runs by name. */
function findListedTools(
  listed: readonly ConnectorTool[],
  args: Record<string, unknown>,
): ToolSearchHit[] {
  const tools = listed.filter((tool) => tool.route && !isLazyCatalogControlRoute(tool.route));
  const { names, query } = findArguments(args);
  if (names.length) return tools.filter((tool) => names.includes(tool.name)).map(toolHit);
  if (!query) return [];
  return rankCatalogEntries(catalogEntries([...tools]), query, FIND_TOOL_LIMIT_PER_SOURCE).hits.map(
    (entry) => toolHit(entry.tool),
  );
}

function toolHit({ name, description, inputSchema }: ConnectorTool): ToolSearchHit {
  return { id: name, name, description, inputSchema, next: "use_tool" };
}

function findArguments(args: Record<string, unknown>) {
  const names = Array.isArray(args.names) ? args.names.map(String) : [];
  const query = String(args.query ?? "")
    .trim()
    .toLowerCase();
  return { names, query };
}

/**
 * What find_tool answers: the deferred built-ins, the connector tools listed directly, and what
 * `search` finds beyond them (held-back connector tools, apps to connect, paid services), named
 * or best for a query, as one ranked list. `hits` keeps what use_tool needs to run each one.
 */
export async function findTools(
  tools: {
    deferred: readonly ConnectorTool[];
    listed?: readonly ConnectorTool[];
    search?: (request: ToolSearchRequest) => Promise<ToolSearchHit[]>;
  },
  args: Record<string, unknown>,
  unavailableToolReasons?: Readonly<Record<string, string>>,
) {
  const { names, query } = findArguments(args);
  const local = [
    ...findBuiltinTools(tools.deferred, args),
    ...findListedTools(tools.listed ?? [], args),
  ];
  const localIds = new Set(local.map((hit) => hit.id));
  const missing = names.filter((name) => !localIds.has(name));
  const remote = names.length
    ? missing.length
      ? ((await tools.search?.({ ids: missing })) ?? [])
      : []
    : query
      ? ((await tools.search?.({ query, limit: FIND_TOOL_LIMIT })) ?? [])
      : [];
  const hits = names.length
    ? [...local, ...remote]
    : rankToolSearchHits([...local, ...remote], query, FIND_TOOL_LIMIT);
  const foundNames = new Set(hits.flatMap((hit) => [hit.id.toLowerCase(), hit.name.toLowerCase()]));
  const unavailableEntries: Array<[string, string]> = [];
  const unavailableNames = new Set<string>();
  const unknown: string[] = [];
  if (names.length) {
    for (const name of names) {
      if (foundNames.has(name.toLowerCase())) continue;
      const reason = unavailableToolReason(unavailableToolReasons, name);
      if (reason !== undefined) {
        if (!unavailableNames.has(name)) {
          unavailableNames.add(name);
          unavailableEntries.push([name, reason]);
        }
      } else {
        unknown.push(name);
      }
    }
  } else if (query && !foundNames.has(query)) {
    const reason = unavailableToolReason(unavailableToolReasons, query);
    if (reason !== undefined) unavailableEntries.push([query, reason]);
  }
  const unavailable = unavailableEntries.length
    ? Object.fromEntries(unavailableEntries)
    : undefined;
  return {
    hits,
    result: {
      tools: hits.map(shownToolSearchHit),
      ...(unavailable ? { unavailable } : {}),
      ...(unknown.length ? { unknown } : {}),
      ...(hits.length || (unavailable && !unknown.length)
        ? {}
        : { hint: "Pass names from this tool's list or other words." }),
    },
  };
}
