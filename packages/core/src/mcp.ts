import { newClientId } from "./client-id.js";
export function deriveMcpSlug(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^[_-]+|-+$/g, "")
      .slice(0, 64) || `mcp-${Date.now()}`
  );
}

export function customMcpServerInput(name: string, endpoint: string) {
  return {
    slug: `integration-${newClientId().slice(0, 8)}`,
    name: name.trim(),
    transport: "streamable_http" as const,
    endpoint: endpoint.trim(),
  };
}
