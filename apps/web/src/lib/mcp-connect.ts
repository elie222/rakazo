import { rpc } from "./rpc";

export const MCP_OAUTH_CHANNEL = "rakazo-mcp-oauth";
const MCP_OAUTH_TIMEOUT_MS = 2 * 60 * 1000;
const MARKETPLACE_RETURN_KEY = "rakazo:mcp-marketplace-return";

/** A fixed same-origin return intent, never an arbitrary redirect URL. */
export function mcpOAuthReturnPath(): string {
  try {
    return window.sessionStorage.getItem(MARKETPLACE_RETURN_KEY) === "1"
      ? "/app?marketplace=installed"
      : "/app";
  } catch {
    return "/app";
  }
}
export function consumeMcpOAuthReturnPath(): string {
  const target = mcpOAuthReturnPath();
  try {
    window.sessionStorage.removeItem(MARKETPLACE_RETURN_KEY);
  } catch {
    /* Storage is optional. */
  }
  return target;
}

export type McpOauthResult =
  | "connected"
  | "cancelled"
  | "already_connected"
  | "authorization_not_requested";

/** Run the browser OAuth popup flow for an MCP server: request an
 * authorization URL, open the popup, and wait until the callback page
 * broadcasts completion or the popup is closed without finishing.
 *
 * The BroadcastChannel (not window.opener) is the completion signal because
 * provider login pages with COOP sever the opener link. */
export async function connectMcpOauth(
  serverId: string,
  options: { returnToMarketplace?: boolean } = {},
): Promise<McpOauthResult> {
  const started = await rpc.mcp.oauth.begin({
    serverId,
    redirectUri: `${window.location.origin}/mcp/oauth/callback`,
  });
  if (started.status !== "authorization_required") return started.status;
  try {
    if (options.returnToMarketplace) window.sessionStorage.setItem(MARKETPLACE_RETURN_KEY, "1");
    else window.sessionStorage.removeItem(MARKETPLACE_RETURN_KEY);
  } catch {
    /* OAuth still works when session storage is unavailable. */
  }
  const popup = window.open(
    started.authorizationUrl,
    MCP_OAUTH_CHANNEL,
    "popup,width=560,height=720",
  );
  if (!popup) {
    // Popup blocked: navigate this tab instead; the callback page returns to /app.
    window.location.assign(started.authorizationUrl);
    return "cancelled";
  }
  return await new Promise<McpOauthResult>((resolve) => {
    const channel = new BroadcastChannel(MCP_OAUTH_CHANNEL);
    let settled = false;
    let pollTimer = 0;
    let timeoutTimer = 0;
    const finish = (result: McpOauthResult) => {
      if (settled) return;
      settled = true;
      window.clearInterval(pollTimer);
      window.clearTimeout(timeoutTimer);
      channel.close();
      consumeMcpOAuthReturnPath();
      resolve(result);
    };
    pollTimer = window.setInterval(() => {
      if (!popup.closed) return;
      finish("cancelled");
    }, 500);
    timeoutTimer = window.setTimeout(() => {
      popup.close();
      finish("cancelled");
    }, MCP_OAUTH_TIMEOUT_MS);
    channel.onmessage = (event: MessageEvent) => {
      if ((event.data as { type?: string } | null)?.type !== "mcp-oauth-complete") return;
      finish("connected");
    };
  });
}
