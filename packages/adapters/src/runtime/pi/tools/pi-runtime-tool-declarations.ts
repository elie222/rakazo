import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ConnectorTool } from "@rakazo/adapter-kit";
import { parametersFor } from "./pi-runtime-tool-parameters.js";

export function modelToolDeclarations(
  tools: AgentTool[],
  toolsByAgentName: ReadonlyMap<string, ConnectorTool>,
  offered: ReadonlyMap<string, ConnectorTool> | undefined,
) {
  if (!offered?.size) return tools;
  return tools.map((tool) => {
    const declaration = offered.get(tool.name);
    if (!declaration || toolsByAgentName.get(tool.name)?.route) return tool;
    return {
      ...tool,
      description: declaration.description,
      parameters: parametersFor(declaration),
    };
  });
}

// Pi copies its initial tools. Keep any temporarily disabled tools out of the next request.
export function matchToolDeclarations(
  current: AgentTool[] | undefined,
  from: AgentTool[],
  to: AgentTool[],
) {
  if (!current?.length || from === to) return current;
  if (
    current === from ||
    (current.length === from.length && current.every((tool, index) => tool === from[index]))
  )
    return to;
  const replacements = new Map(from.map((tool, index) => [tool, to[index]!]));
  return current.map((tool) => replacements.get(tool) ?? tool);
}
