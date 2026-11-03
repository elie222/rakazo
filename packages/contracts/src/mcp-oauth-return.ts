import * as z from "zod";

/** Which client starts an MCP sign-in: the mobile app, or a browser when omitted. */
export const McpOAuthBeginClientSchema = z.literal("mobile").optional();
export type McpOAuthBeginClient = z.infer<typeof McpOAuthBeginClientSchema>;

/** The deep link the web OAuth callback hands a mobile MCP sign-in back to. */
export const MOBILE_MCP_OAUTH_CALLBACK_URL = "rakazo://mcp-oauth";
/** Marks the state of an MCP sign-in the mobile app started; the app, not the browser, completes it. */
export const MOBILE_MCP_OAUTH_STATE_PREFIX = "mobile-";

/** Where the web callback sends a sign-in the mobile app started, or null when the browser finishes it. */
export function mobileMcpOAuthReturnUrl(params: URLSearchParams): string | null {
  if (!params.get("state")?.startsWith(MOBILE_MCP_OAUTH_STATE_PREFIX)) return null;
  return `${MOBILE_MCP_OAUTH_CALLBACK_URL}?${params}`;
}
