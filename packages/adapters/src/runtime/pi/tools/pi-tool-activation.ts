import type { Message } from "@earendil-works/pi-ai";
import type { ConnectorTool } from "@rakazo/adapter-kit";
import { z } from "zod";
import { FIND_TOOL } from "../../../tools/builtin.tool-definition.js";
import { partitionTools } from "../../../tools/builtin-tool-bridge.js";
import { CATALOG_EXECUTE, CATALOG_LOAD } from "../../../tools/lazy-tool-catalog.js";
import { namedAgentTools, normalizeAgentToolName } from "./pi-runtime-tools.js";

/**
 * How a run reaches a tool after the model loads its schema: only through the wrappers
 * (`<prefix>_execute_tool`, `use_tool`), or also by its own name from the next model request.
 */
export type ToolActivation = "wrapper" | "direct";

/** Read once per run; `RAKAZO_TOOL_ACTIVATION=direct` turns direct calls on. */
export function toolActivationMode(env: NodeJS.ProcessEnv = process.env): ToolActivation {
  return env.RAKAZO_TOOL_ACTIVATION === "direct" ? "direct" : "wrapper";
}

/**
 * A loaded tool under the name the model calls it. A connector tool runs as the catalog's
 * execute wrapper with its id, so it keeps that call's gate, approvals and result bounding.
 */
export interface ActivatedTool {
  name: string;
  tool: ConnectorTool;
  via?: { wrapper: ConnectorTool; id: string };
}

const LoadedCatalogTool = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  inputSchema: z.record(z.string(), z.unknown()),
  readOnly: z.boolean(),
});

const FoundBuiltins = z.object({ tools: z.array(z.object({ name: z.string() })) });

function isCatalogRoute(tool: ConnectorTool, toolName: string): boolean {
  return Boolean(tool.route && !tool.route.resourceId && tool.route.toolName === toolName);
}

/**
 * Tools this transcript loaded: schemas a catalog's load tool returned and built-ins find_tool
 * returned. Derived from the messages alone, so a resumed turn gets the same tools back.
 */
export function activatedTools(
  messages: readonly Message[],
  offered: readonly ConnectorTool[],
): ActivatedTool[] {
  const { deferred } = partitionTools(offered);
  const taken = new Set(namedAgentTools(partitionTools(offered).listed).map(({ name }) => name));
  const activated = new Map<string, ActivatedTool>();
  const add = (entry: ActivatedTool) => {
    if (taken.has(entry.name) || activated.has(entry.name)) return;
    activated.set(entry.name, entry);
  };
  for (const message of messages) {
    if (message.role !== "toolResult" || message.isError) continue;
    if (message.toolName === FIND_TOOL) {
      const found = FoundBuiltins.safeParse(message.details);
      for (const { name } of found.data?.tools ?? []) {
        const tool = deferred.find((candidate) => candidate.name === name);
        if (tool) add({ name: tool.name, tool });
      }
      continue;
    }
    const loader = offered.find(
      (tool) => tool.name === message.toolName && isCatalogRoute(tool, CATALOG_LOAD),
    );
    if (!loader) continue;
    const wrapper = offered.find(
      (tool) =>
        tool.route?.connectorId === loader.route?.connectorId &&
        isCatalogRoute(tool, CATALOG_EXECUTE),
    );
    const loaded = LoadedCatalogTool.safeParse(message.details);
    if (!wrapper || !loaded.success) continue;
    const { id, ...tool } = loaded.data;
    add({ name: normalizeAgentToolName(tool.name), tool, via: { wrapper, id } });
  }
  return [...activated.values()];
}
