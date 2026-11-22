import { t } from "@lingui/core/macro";
import type { McpServer, McpServerConfigInput, McpServerConnection } from "@rakazo/contracts";

export function mcpConnectionLabel(state: McpServerConnection): string {
  switch (state) {
    case "disabled":
      return t`Disabled`;
    case "needs_client":
      return t`Needs an OAuth client ID`;
    case "needs_sign_in":
      return t`Needs sign-in`;
    case "not_working":
      return t`Not working`;
    case "connected":
      return t`Connected`;
    case "not_connected":
      return t`Not connected`;
  }
}

/** Which bots can use a server: every bot, or only `botIds`. */
export type McpServerAccess = { allBots: boolean; botIds: string[] };

export function sameMcpServerAccess(a: McpServerAccess, b: McpServerAccess): boolean {
  return a.allBots === b.allBots && [...a.botIds].sort().join() === [...b.botIds].sort().join();
}

/** What the edit screen can change on a remote server; secrets start blank and blank keeps them. */
export type RemoteMcpServerEdit = {
  name: string;
  endpoint: string;
  token: string;
  transport: "streamable_http" | "sse";
  headerName: string;
  headerValue: string;
  oauthClientId: string;
  oauthClientSecret: string;
  oauthScope: string;
  oauthParams: string;
  verbatimResults: boolean;
};

export function remoteMcpServerEdit(server: McpServer): RemoteMcpServerEdit {
  return {
    name: server.name,
    endpoint: server.endpoint ?? "",
    token: "",
    transport: server.transport === "sse" ? "sse" : "streamable_http",
    headerName: server.headerKeys[0] ?? "Authorization",
    headerValue: "",
    oauthClientId: "",
    oauthClientSecret: "",
    oauthScope: "",
    oauthParams: "",
    verbatimResults: server.verbatimResults,
  };
}

/** Whether a saved server uses any setting kept under Advanced. */
export function mcpAdvancedInUse(server: McpServer): boolean {
  return (
    server.transport === "sse" ||
    server.headerKeys.length > 0 ||
    server.oauthClientId !== null ||
    server.verbatimResults
  );
}

/** The edited header's name: a value typed without one goes in Authorization, as on web. */
function editedHeaderName(edit: RemoteMcpServerEdit): string {
  return edit.headerName.trim() || (edit.headerValue.trim() ? "Authorization" : "");
}

/**
 * Whether the edited header can be saved. Its value is never read back, so renaming the
 * stored header needs a new value; clearing the name and value removes it.
 */
export function mcpHeaderEditValid(server: McpServer, edit: RemoteMcpServerEdit): boolean {
  const stored = server.headerKeys[0];
  const name = editedHeaderName(edit);
  return !stored || !name || name === stored || Boolean(edit.headerValue.trim());
}

export function remoteMcpServerChanged(server: McpServer, edit: RemoteMcpServerEdit): boolean {
  const stored = server.headerKeys[0];
  return (
    edit.name.trim() !== server.name ||
    edit.endpoint.trim() !== server.endpoint ||
    Boolean(edit.token) ||
    edit.transport !== server.transport ||
    Boolean(edit.headerValue.trim()) ||
    (stored !== undefined && editedHeaderName(edit) !== stored) ||
    Boolean(edit.oauthClientId.trim()) ||
    edit.verbatimResults !== server.verbatimResults
  );
}

/**
 * A remote server's saved settings with the edits applied. Stored headers are sent blank,
 * which keeps them, and a blank token keeps the stored one. The OAuth client is sent only
 * when a client ID is entered, since its stored scope is never read back. A stdio server has
 * none.
 */
export function remoteMcpServerUpdate(
  server: McpServer,
  edit: RemoteMcpServerEdit,
): McpServerConfigInput | null {
  if (server.transport === "stdio") return null;
  const stored = server.headerKeys[0];
  const headerName = editedHeaderName(edit);
  const headerValue = edit.headerValue.trim();
  const headers: Record<string, string> = Object.fromEntries(
    server.headerKeys.map((key) => [key, ""]),
  );
  if (stored && headerName !== stored) delete headers[stored];
  if (headerName && headerValue) headers[headerName] = headerValue;
  const clientId = edit.oauthClientId.trim();
  return {
    slug: server.slug,
    name: edit.name.trim(),
    description: server.description,
    enabled: server.enabled,
    verbatimResults: edit.verbatimResults,
    transport: edit.transport,
    endpoint: edit.endpoint.trim(),
    headers,
    secret: edit.token || undefined,
    oauthClient: clientId
      ? {
          clientId,
          clientSecret: edit.oauthClientSecret || undefined,
          scope: edit.oauthScope.trim() || undefined,
          authorizationParams: edit.oauthParams.trim() || undefined,
        }
      : undefined,
  };
}
