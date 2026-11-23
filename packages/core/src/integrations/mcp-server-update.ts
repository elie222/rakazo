/**
 * The save rules web and mobile share for a remote MCP server's form. A form edits one header,
 * starting from the first stored one, and never reads a stored value back.
 */

/** Which bots can use a server: every bot, or only `botIds`. */
export type McpServerAccess = { allBots: boolean; botIds: string[] };

export function sameMcpServerAccess(a: McpServerAccess, b: McpServerAccess): boolean {
  return a.allBots === b.allBots && [...a.botIds].sort().join() === [...b.botIds].sort().join();
}

/** The edited header's name: a value typed without one goes in Authorization. */
export function mcpEditedHeaderName(name: string, value: string): string {
  return name.trim() || (value.trim() ? "Authorization" : "");
}

/**
 * The headers a remote server saves. A stored header is sent blank, which keeps its value
 * (the API drops it instead when the URL moves). A typed value is saved under the edited name
 * and replaces the edited stored header, and clearing the name removes it. A rename without a value keeps the stored header,
 * since its value cannot be moved.
 */
export function mcpServerHeaders(input: {
  storedKeys: readonly string[];
  name: string;
  value: string;
}): Record<string, string> {
  const name = mcpEditedHeaderName(input.name, input.value);
  const value = input.value.trim();
  const edited = input.storedKeys[0];
  const headers: Record<string, string> = Object.fromEntries(
    input.storedKeys.map((key) => [key, ""]),
  );
  if (edited && name !== edited && (value || !name)) delete headers[edited];
  if (name && value) headers[name] = value;
  return headers;
}

/** Whether the edited header can be saved: renaming a stored header needs a new value. */
export function mcpHeaderEditValid(
  storedKeys: readonly string[],
  name: string,
  value: string,
): boolean {
  const stored = storedKeys[0];
  const edited = mcpEditedHeaderName(name, value);
  return !stored || !edited || edited === stored || Boolean(value.trim());
}

/**
 * The OAuth client a form saves, sent only when a client ID is entered: the stored scope and
 * parameters are never read back, so resending the client without them would replace them.
 */
export function mcpOAuthClientInput(input: {
  clientId: string;
  clientSecret: string;
  scope: string;
  params: string;
}) {
  const clientId = input.clientId.trim();
  if (!clientId) return undefined;
  return {
    clientId,
    clientSecret: input.clientSecret || undefined,
    scope: input.scope.trim() || undefined,
    authorizationParams: input.params.trim() || undefined,
  };
}
