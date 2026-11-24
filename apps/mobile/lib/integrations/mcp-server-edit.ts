import type { McpServer, McpServerConfigInput } from "@rakazo/contracts";
import { mcpEditedHeaderName, mcpOAuthClientInput, mcpServerHeaders } from "@rakazo/core";

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

export function remoteMcpServerChanged(server: McpServer, edit: RemoteMcpServerEdit): boolean {
  const stored = server.headerKeys[0];
  return (
    edit.name.trim() !== server.name ||
    edit.endpoint.trim() !== server.endpoint ||
    Boolean(edit.token.trim()) ||
    edit.transport !== server.transport ||
    Boolean(edit.headerValue.trim()) ||
    (stored !== undefined && mcpEditedHeaderName(edit.headerName, edit.headerValue) !== stored) ||
    Boolean(edit.oauthClientId.trim()) ||
    edit.verbatimResults !== server.verbatimResults
  );
}

/** A remote server's saved settings with the edits applied; a stdio server has none. */
export function remoteMcpServerUpdate(
  server: McpServer,
  edit: RemoteMcpServerEdit,
): McpServerConfigInput | null {
  if (server.transport === "stdio") return null;
  return {
    slug: server.slug,
    name: edit.name.trim(),
    description: server.description,
    enabled: server.enabled,
    verbatimResults: edit.verbatimResults,
    transport: edit.transport,
    endpoint: edit.endpoint.trim(),
    headers: mcpServerHeaders({
      storedKeys: server.headerKeys,
      name: edit.headerName,
      value: edit.headerValue,
    }),
    // A blank token keeps the stored one.
    secret: edit.token.trim() || undefined,
    oauthClient: mcpOAuthClientInput({
      clientId: edit.oauthClientId,
      clientSecret: edit.oauthClientSecret,
      scope: edit.oauthScope,
      params: edit.oauthParams,
    }),
  };
}
