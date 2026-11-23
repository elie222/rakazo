import * as z from "zod";

/** Which app starts an MCP sign-in: the mobile app, or a browser when omitted. */
export const McpOAuthClientKindSchema = z.literal("mobile").optional();
export type McpOAuthClientKind = z.infer<typeof McpOAuthClientKindSchema>;

/** The app can read the code from a loopback redirect itself, as the desktop app's sign-in
 * window does, so a server that registers only loopback redirects can still be signed in to. */
export const McpCapturesLoopbackSchema = z.boolean().optional();

/** The deep link the web callback hands a mobile app's MCP sign-in back to. */
export const MOBILE_MCP_OAUTH_CALLBACK_URL = "rakazo://mcp-oauth";
/** Starts the state of a sign-in the mobile app began, so the web callback hands it back. */
export const MOBILE_MCP_OAUTH_STATE_PREFIX = "mobile-";

/** Where the web callback sends a sign-in the mobile app started, or null when the browser finishes it. */
export function mobileMcpOAuthReturnUrl(params: URLSearchParams): string | null {
  if (!params.get("state")?.startsWith(MOBILE_MCP_OAUTH_STATE_PREFIX)) return null;
  return `${MOBILE_MCP_OAUTH_CALLBACK_URL}?${params}`;
}
