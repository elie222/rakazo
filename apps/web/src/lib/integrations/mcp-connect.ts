import { MCP_SIGNIN_WINDOW_PREFIX } from "@rakazo/contracts";
import { MCP_OAUTH_CALLBACK_PATH } from "../auth/sign-in-next";
import { desktopBridge } from "../platform/desktop";
import { rpc } from "../query/rpc";
import { MCP_OAUTH_CHANNEL } from "./mcp-oauth-channel";

export { MCP_OAUTH_CHANNEL } from "./mcp-oauth-channel";

const MCP_OAUTH_TIMEOUT_MS = 2 * 60 * 1000;
/** The main process closes a captured popup just before its message reaches us. */
const CAPTURE_GRACE_MS = 500;

export type McpOauthResult =
  | "connected"
  | "cancelled"
  | "already_connected"
  | "authorization_not_requested";

/** Where providers send the user back; a pre-registered client must allow it. */
export function mcpOAuthRedirectUri(): string {
  return `${window.location.origin}${MCP_OAUTH_CALLBACK_PATH}`;
}

/** Run the browser OAuth popup flow for an MCP server: request an
 * authorization URL, open the popup, and wait until the callback page
 * broadcasts completion or the popup is closed without finishing.
 *
 * The BroadcastChannel (not window.opener) is the completion signal because
 * provider login pages with COOP sever the opener link. The desktop shell
 * gives each server its own browser session, so its popup never reaches the
 * callback page; the main process captures the code and reports it instead. */
export async function connectMcpOauth(serverId: string): Promise<McpOauthResult> {
  const started = await rpc.mcp.oauth.begin({ serverId, redirectUri: mcpOAuthRedirectUri() });
  if (started.status !== "authorization_required") return started.status;
  return await signInInPopup(serverId, started);
}

/** Adds a remote MCP server by URL, or reuses the one already added, and signs in to it. The
 * bot gets the server once the sign-in finishes, even when it finishes in this tab instead. */
export async function connectMcpEndpoint(input: {
  name: string;
  endpoint: string;
  botId?: string;
}): Promise<McpOauthResult> {
  const { server, signIn } = await rpc.mcp.servers.connect({
    ...input,
    redirectUri: mcpOAuthRedirectUri(),
  });
  if (signIn.status !== "authorization_required") return signIn.status;
  // The popup opens only now: on desktop its name carries the server id.
  return await signInInPopup(server.id, signIn);
}

async function signInInPopup(
  serverId: string,
  started: { sessionId: string; authorizationUrl: string },
): Promise<McpOauthResult> {
  const browser = desktopBridge()?.mcpBrowser;
  const popup = window.open(
    started.authorizationUrl,
    // The desktop shell gives a per-server window its own browser session.
    browser
      ? `${MCP_SIGNIN_WINDOW_PREFIX}${serverId}`
      : `${MCP_OAUTH_CHANNEL}:${started.sessionId}`,
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
    let captured = false;
    let pollTimer = 0;
    let timeoutTimer = 0;
    let unsubscribe: (() => void) | undefined;
    const finish = (result: McpOauthResult | Error) => {
      if (settled) return;
      settled = true;
      window.clearInterval(pollTimer);
      window.clearTimeout(timeoutTimer);
      channel.close();
      unsubscribe?.();
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    // COOP makes an open popup read as closed, but it keeps focus until the
    // user really closes it.
    pollTimer = window.setInterval(() => {
      if (!popup.closed || !document.hasFocus()) return;
      if (!browser) return finish("cancelled");
      // A captured sign-in closes the popup as it hands over the code; give
      // that message its turn before counting the closed window as a cancel.
      window.clearInterval(pollTimer);
      window.setTimeout(() => {
        if (captured) return;
        // COOP can misreport an open popup as closed; close it so a sign-in
        // nobody is waiting for cannot be finished there.
        popup.close();
        finish("cancelled");
      }, CAPTURE_GRACE_MS);
    }, 500);
    timeoutTimer = window.setTimeout(() => {
      popup.close();
      finish("cancelled");
    }, MCP_OAUTH_TIMEOUT_MS);
    channel.onmessage = (event: MessageEvent) => {
      const message = event.data as { type?: string; sessionId?: string; message?: string } | null;
      if (message?.sessionId !== started.sessionId) return;
      const type = message?.type;
      if (type === "mcp-oauth-failed") {
        finish(new Error(message?.message));
        return;
      }
      if (type !== "mcp-oauth-complete") return;
      finish("connected");
    };
    unsubscribe = browser?.onOAuthCallback((callback) => {
      if (callback.serverId !== serverId || callback.state !== started.sessionId) return;
      // A sign-in session completes only once; ignore a repeated report.
      if (captured) return;
      captured = true;
      window.clearTimeout(timeoutTimer);
      if (callback.code === null) return finish("cancelled");
      void rpc.mcp.oauth
        .complete({ sessionId: callback.state, code: callback.code, state: callback.state })
        .then(
          () => {
            // Other open views refresh on the same signal the callback page sends.
            channel.postMessage({ type: "mcp-oauth-complete", sessionId: started.sessionId });
            finish("connected");
          },
          (error: unknown) => finish(error instanceof Error ? error : new Error(String(error))),
        );
    });
  });
}
