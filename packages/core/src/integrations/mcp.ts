import { trimEndChars } from "@rakazo/contracts";
import { newClientId } from "../primitives/client-id.js";
export function deriveMcpSlug(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[_-]+/, "");
  return trimEndChars(slug, "-").slice(0, 64) || `mcp-${Date.now()}`;
}

export function customMcpServerInput(name: string, endpoint: string) {
  return {
    slug: `integration-${newClientId().slice(0, 8)}`,
    name: name.trim(),
    transport: "streamable_http" as const,
    endpoint: endpoint.trim(),
  };
}
