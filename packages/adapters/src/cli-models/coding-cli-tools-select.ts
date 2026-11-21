import type { ConnectorTool } from "@rakazo/adapter-kit";

export const CODING_CLI_TOOL_NAMES = new Set(["coding_cli_run"]);

export function selectCodingCliTools(
  tools: ConnectorTool[],
  codingCliConfigured: boolean,
): ConnectorTool[] {
  return codingCliConfigured
    ? tools
    : tools.filter((tool) => !CODING_CLI_TOOL_NAMES.has(tool.name));
}
