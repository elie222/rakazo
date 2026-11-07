import { createHash } from "node:crypto";

const OAUTH_POPUP_NAMES = new Set([
  "rakazo-app-connect",
  "rakazo-mcp-oauth",
  "rakazo-sso-oauth",
  "rakazo-model-oauth",
  "rakazo-plugin-connect",
]);

/** An MCP sign-in window's name carries the server it belongs to after this prefix. */
const MCP_OAUTH_POPUP_PREFIX = "rakazo-mcp-oauth:";

/** A server id from an MCP sign-in window name; null for the shared browser name. */
export function mcpOAuthPopupServerId(frameName: string): string | null {
  if (!frameName.startsWith(MCP_OAUTH_POPUP_PREFIX)) return null;
  const serverId = frameName.slice(MCP_OAUTH_POPUP_PREFIX.length);
  return isMcpOAuthServerId(serverId) ? serverId : null;
}

export function isMcpOAuthServerId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(value);
}

/** One persistent cookie jar per server, so sign-ins never share cookies. */
export function mcpOAuthPartition(serverId: string) {
  const digest = createHash("sha256").update(serverId).digest("hex").slice(0, 24);
  return `persist:rakazo-mcp-${digest}`;
}

export function shouldOpenInAppPopup(
  appOrigin: string | null,
  childUrl: string,
  frameName: string,
) {
  let target: URL;
  try {
    target = new URL(childUrl);
  } catch {
    return false;
  }

  if (childUrl === "about:blank" && frameName === "rakazo-sso-oauth") return true;

  const isHttp = target.protocol === "http:" || target.protocol === "https:";
  if (appOrigin !== null && target.origin === appOrigin) return isHttp;
  return (
    target.protocol === "https:" &&
    (OAUTH_POPUP_NAMES.has(frameName) || mcpOAuthPopupServerId(frameName) !== null)
  );
}

/** Keep auth cookies in the parent app's server-specific session. */
export function oauthPopupSessionPreferences(partition: string | null) {
  return {
    preload: "",
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
    ...(partition === null ? {} : { partition }),
  };
}
