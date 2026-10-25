import {
  assertSafeRemoteUrl,
  callRemoteMcpTool,
  isPrivateRemoteMcpHostname,
} from "./remote-mcp.js";

export const REMBRIC_REQUEST_ERROR = "Rembric request failed or returned an invalid response.";

export interface RembricConnection {
  endpoint: string;
  spaceId: string;
  projectId: string;
  token: string;
  endpointTrust?: string;
}

export function rembricEndpoint(endpoint: string): string {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error("Invalid Rembric endpoint.");
  }
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.href.includes("?") ||
    url.href.includes("#") ||
    !/^\/mcp\/[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/.test(url.pathname)
  )
    throw new Error("Rembric endpoint must target a project slug.");
  return url.href;
}

export function rembricRequiresPrivateEndpoint(settings: Record<string, string>): boolean {
  if (settings.endpointTrust === "private") return true;
  try {
    const url = new URL(settings.endpoint ?? "");
    return url.protocol === "http:" || isPrivateRemoteMcpHostname(url.hostname);
  } catch {
    return false;
  }
}

/** Use the same DNS, metadata, redirect and credential guards as installed remote MCP. */
export async function classifyRembricConnectionSettings(
  settings: Record<string, string>,
): Promise<Record<string, string>> {
  const endpoint = rembricEndpoint(settings.endpoint ?? "");
  try {
    await assertSafeRemoteUrl(endpoint);
    return { ...settings, endpoint, endpointTrust: "public" };
  } catch {
    try {
      await assertSafeRemoteUrl(endpoint, undefined, { allowPrivateEndpoint: true });
    } catch {
      throw new Error("Rembric endpoint failed network trust validation.");
    }
    return { ...settings, endpoint, endpointTrust: "private" };
  }
}

export async function revalidateRembricSettings(
  settings: Record<string, string>,
  options?: { spaceId?: string },
): Promise<void> {
  if (options?.spaceId !== undefined && options.spaceId !== settings.spaceId) {
    throw new Error("Rembric connection belongs to another Space.");
  }
  const endpoint = rembricEndpoint(settings.endpoint ?? "");
  if (!nonempty(settings.spaceId) || !nonempty(settings.projectId))
    throw new Error("Rembric Space and project binding are required.");
  try {
    await assertSafeRemoteUrl(endpoint, undefined, {
      allowPrivateEndpoint:
        settings.endpointTrust === "private" && process.env.MCP_ALLOW_PRIVATE_ENDPOINT === "true",
    });
  } catch {
    throw new Error("Rembric endpoint failed network trust validation.");
  }
}

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(REMBRIC_REQUEST_ERROR);
  return value as Record<string, unknown>;
}

export function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export async function callRembric(
  connection: RembricConnection,
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
  allowPrivateEndpoint = connection.endpointTrust === "private" &&
    process.env.MCP_ALLOW_PRIVATE_ENDPOINT === "true",
): Promise<Record<string, unknown>> {
  try {
    const envelope = record(
      await callRemoteMcpTool(
        {
          endpoint: rembricEndpoint(connection.endpoint),
          headers: { Authorization: `Bearer ${connection.token}` },
          signal,
          allowPrivateEndpoint,
        },
        name,
        args,
      ),
    );
    if (envelope.isError || envelope.truncated) throw new Error(REMBRIC_REQUEST_ERROR);
    let payload = envelope.structuredContent;
    if (payload === undefined) {
      const content = envelope.content;
      if (!Array.isArray(content) || content.length !== 1) throw new Error(REMBRIC_REQUEST_ERROR);
      const text = record(content[0]);
      if (text.type !== "text" || typeof text.text !== "string")
        throw new Error(REMBRIC_REQUEST_ERROR);
      payload = JSON.parse(text.text);
    }
    const body = record(payload);
    if (body.error || body.truncated || body.ok === false) throw new Error(REMBRIC_REQUEST_ERROR);
    return body;
  } catch {
    throw new Error(REMBRIC_REQUEST_ERROR);
  }
}

export async function currentRembricProject(
  connection: RembricConnection,
  signal?: AbortSignal,
  allowPrivateEndpoint?: boolean,
): Promise<string> {
  const row = await callRembric(connection, "project.current", {}, signal, allowPrivateEndpoint);
  if (
    row.slug !== new URL(connection.endpoint).pathname.slice("/mcp/".length) ||
    !nonempty(row.projectId) ||
    typeof row.source !== "string" ||
    !Array.isArray(row.suggestedSlugs) ||
    !row.suggestedSlugs.every((slug) => typeof slug === "string") ||
    (connection.projectId && row.projectId !== connection.projectId)
  ) {
    throw new Error(
      "Rembric project is missing or inaccessible for this Space; check the project and token.",
    );
  }
  return row.projectId;
}
