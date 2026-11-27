import type { ConnectorTool } from "@rakazo/adapter-kit";
import { humanizeToolName } from "@rakazo/core";
import { composioOutgoingDraft, composioSessionToolBatch } from "./composio-batch.js";

export function asConnectorTools(input: unknown): ConnectorTool[] {
  const items = Array.isArray(input)
    ? input
    : input && typeof input === "object" && Array.isArray((input as { items?: unknown }).items)
      ? ((input as { items: unknown[] }).items ?? [])
      : [];
  const tools: ConnectorTool[] = [];
  for (const item of items) {
    const mapped = mapOneTool(item);
    if (mapped) tools.push(mapped);
  }
  return tools;
}

function mapOneTool(item: unknown): ConnectorTool | undefined {
  if (!item || typeof item !== "object") return undefined;
  const raw = item as Record<string, unknown>;
  if (raw.type === "function" && raw.function && typeof raw.function === "object") {
    const fn = raw.function as Record<string, unknown>;
    const name = String(fn.name ?? "");
    if (!name) return undefined;
    return {
      name,
      description: String(fn.description ?? name),
      inputSchema: asObject(fn.parameters) ?? { type: "object", properties: {} },
      batch: composioSessionToolBatch(name),
      outgoingDraft: composioOutgoingDraft(name),
      ...composioToolLabel(name),
      route: { connectorId: "composio", toolName: name },
    };
  }
  const name = String(raw.slug ?? raw.name ?? "");
  if (!name) return undefined;
  return {
    name,
    description: String(raw.description ?? name),
    inputSchema: asObject(raw.inputParameters) ??
      asObject(raw.inputSchema) ??
      asObject(raw.parameters) ?? { type: "object", properties: {} },
    batch: composioSessionToolBatch(name),
    outgoingDraft: composioOutgoingDraft(name),
    ...composioToolLabel(name),
    route: { connectorId: "composio", toolName: name },
  };
}

const COMPOSIO_TOOL_PREFIX = "COMPOSIO_";
const COMPOSIO_TOOL_LABELS: Record<string, string> = {
  COMPOSIO_SEARCH_TOOLS: "Searching your apps",
  COMPOSIO_GET_TOOL_SCHEMAS: "Checking app details",
  COMPOSIO_MULTI_EXECUTE_TOOL: "Using your apps",
  COMPOSIO_REMOTE_WORKBENCH: "Running code",
  COMPOSIO_REMOTE_BASH_TOOL: "Running code",
  COMPOSIO_MANAGE_CONNECTIONS: "Checking connections",
};

/** Session tools carry the vendor's name, which means nothing to the person watching. */
function composioToolLabel(name: string): { label?: string } {
  if (!name.startsWith(COMPOSIO_TOOL_PREFIX)) return {};
  return {
    label: COMPOSIO_TOOL_LABELS[name] ?? humanizeToolName(name.slice(COMPOSIO_TOOL_PREFIX.length)),
  };
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
