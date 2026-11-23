import type { ConnectorTool } from "@rakazo/adapter-kit";

export const TOOL_SEARCH_LIMIT = 10;
export const NAME_INDEX_MAX_NAMES = 200;
export const NAME_INDEX_MAX_BYTES = 2_048;
export const MAX_QUERY_LENGTH = 200;
export const MAX_GROUP_LENGTH = 200;
export const MAX_TOOL_ID_LENGTH = 500;
export const CATALOG_SEARCH = "__catalog_search";
export const CATALOG_LOAD = "__catalog_load";
export const CATALOG_EXECUTE = "__catalog_execute";

export type CatalogNameGroup = { group: string; names: string[] };

/**
 * Build the three catalog wrapper tools (`<prefix>_search_tools`, `<prefix>_load_tool`,
 * `<prefix>_execute_tool`). Callers must not pass a prefix that yields names starting with
 * `mcp_`: Anthropic's Claude Code OAuth endpoint rejects such requests on every model with a
 * misleading "out of extra usage" error. `mcp__server__tool` (double underscore) is fine.
 */
export function lazyCatalogToolDefinitions(
  prefix: string,
  connectorId: string,
  label: string,
  grouped: CatalogNameGroup[],
): ConnectorTool[] {
  const searchDescription =
    grouped.length > 0 && fitsNameIndexBudget(grouped)
      ? `Search connected ${label} tools. Empty query lists names by source. Pass group to expand one source.\n${formatNameIndexText(grouped)}`
      : `Search connected ${label} tools. Empty query lists sources. Pass group to list names in one source, or query to search.${sourceSummaryText(grouped)}`;
  return [
    {
      name: `${prefix}_search_tools`,
      description: searchDescription,
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            maxLength: MAX_QUERY_LENGTH,
            description: "Words describing the tool to find. Omit to list names by source.",
          },
          group: {
            type: "string",
            maxLength: MAX_GROUP_LENGTH,
            description: "Source name to list or search within",
          },
          limit: { type: "integer", minimum: 1, maximum: TOOL_SEARCH_LIMIT },
        },
      },
      readOnly: true,
      route: { connectorId, toolName: CATALOG_SEARCH },
    },
    {
      name: `${prefix}_load_tool`,
      description: `Load one ${label} tool's parameters by id.`,
      inputSchema: {
        type: "object",
        properties: {
          id: {
            type: "string",
            maxLength: MAX_TOOL_ID_LENGTH,
            description: "Exact tool ID returned by search",
          },
        },
        required: ["id"],
      },
      readOnly: true,
      route: { connectorId, toolName: CATALOG_LOAD },
    },
    {
      name: `${prefix}_execute_tool`,
      description: `Run an ${label} tool by id.`,
      inputSchema: {
        type: "object",
        properties: {
          id: {
            type: "string",
            maxLength: MAX_TOOL_ID_LENGTH,
            description: "Exact tool ID returned by search",
          },
          arguments: { type: "object", description: "Arguments matching the loaded schema" },
        },
        required: ["id", "arguments"],
      },
      route: { connectorId, toolName: CATALOG_EXECUTE },
    },
  ];
}

export function formatNameIndexText(groups: CatalogNameGroup[]): string {
  return groups.map(({ group, names }) => `${group}:\n  ${names.join(", ")}`).join("\n");
}

export function fitsNameIndexBudget(groups: CatalogNameGroup[]): boolean {
  const nameCount = groups.reduce((total, group) => total + group.names.length, 0);
  if (nameCount > NAME_INDEX_MAX_NAMES) return false;
  return Buffer.byteLength(formatNameIndexText(groups), "utf8") <= NAME_INDEX_MAX_BYTES;
}

/** Overflowing sources still appear by name and count, with names for those that fit. */
function sourceSummaryText(groups: CatalogNameGroup[]): string {
  if (groups.length === 0) return "";
  const sources = groups.map(({ group, names }) => `${group} (${names.length})`).join(", ");
  const listed: CatalogNameGroup[] = [];
  for (const group of groups) {
    if (fitsNameIndexBudget([...listed, group])) listed.push(group);
  }
  return listed.length > 0
    ? `\nSources: ${sources}\n${formatNameIndexText(listed)}`
    : `\nSources: ${sources}`;
}
