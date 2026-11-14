import { desktopBridge } from "./desktop";
import { MCP_OAUTH_CHANNEL } from "./mcp-oauth-channel";
import { rpc } from "./rpc";

export { MCP_OAUTH_CHANNEL } from "./mcp-oauth-channel";

const MCP_OAUTH_TIMEOUT_MS = 2 * 60 * 1000;
/** The main process closes a captured popup just before its message reaches us. */
const CAPTURE_GRACE_MS = 500;

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
 * provider login pages with COOP sever the opener link. The desktop shell
 * gives each server its own browser session, so its popup never reaches the
 * callback page; the main process captures the code and reports it instead. */
/** Where providers send the user back; a pre-registered client must allow it. */
export function mcpOAuthRedirectUri(): string {
  return `${window.location.origin}/mcp/oauth/callback`;
}

/** A per-server name keeps the desktop shell's cookie jar in step with the popup. */
export function mcpOAuthWindowName(serverId: string, perServerBrowser: boolean): string {
  return perServerBrowser ? `${MCP_OAUTH_CHANNEL}:${serverId}` : MCP_OAUTH_CHANNEL;
}

/** Whether this window is an MCP sign-in popup, shared or per-server. */
export function isMcpOAuthPopupWindow(name: string): boolean {
  return name === MCP_OAUTH_CHANNEL || name.startsWith(`${MCP_OAUTH_CHANNEL}:`);
}

export async function connectMcpOauth(serverId: string): Promise<McpOauthResult> {
  const started = await rpc.mcp.oauth.begin({ serverId, redirectUri: mcpOAuthRedirectUri() });
  if (started.status !== "authorization_required") return started.status;
  const browser = desktopBridge()?.mcpBrowser;
  const popup = window.open(
    started.authorizationUrl,
    mcpOAuthWindowName(serverId, browser !== undefined),
    "popup,width=560,height=720",
  );
  if (!popup) {
    // Popup blocked: navigate this tab instead; the callback page returns to /app.
    window.location.assign(started.authorizationUrl);
    return "cancelled";
  }
  return await new Promise<McpOauthResult>((resolve, reject) => {
    const channel = new BroadcastChannel(MCP_OAUTH_CHANNEL);
    let settled = false;
    let pollTimer = 0;
    let timeoutTimer = 0;
    let unsubscribe: (() => void) | undefined;
    const finish = (result: McpOauthResult) => {
      if (settled) return;
      settled = true;
      window.clearInterval(pollTimer);
      window.clearTimeout(timeoutTimer);
      channel.close();
      unsubscribe?.();
      resolve(result);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      window.clearInterval(pollTimer);
      window.clearTimeout(timeoutTimer);
      channel.close();
      unsubscribe?.();
      reject(error);
    };
    // COOP makes an open popup read as closed, but it keeps focus until the
    // user really closes it.
    pollTimer = window.setInterval(() => {
      if (!popup.closed || !document.hasFocus()) return;
      // A captured sign-in closes the popup as it hands over the code; give
      // that message its turn before counting the closed window as a cancel.
      if (browser) {
        window.clearInterval(pollTimer);
        window.setTimeout(() => finish("cancelled"), CAPTURE_GRACE_MS);
        return;
      }
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
    if (browser) {
      unsubscribe = browser.onOAuthCallback((callback) => {
        if (callback.serverId !== serverId) return;
        if ("error" in callback) {
          popup.close();
          fail(new Error(callback.error));
          return;
        }
        if (callback.state !== started.sessionId) return;
        void rpc.mcp.oauth
          .complete({ sessionId: callback.state, code: callback.code, state: callback.state })
          .then(() => {
            channel.postMessage({ type: "mcp-oauth-complete" });
            finish("connected");
          }, fail);
      });
    }
  });
}
