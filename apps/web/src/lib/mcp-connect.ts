import { rpc } from "./rpc";

export const MCP_OAUTH_CHANNEL = "rakazo-mcp-oauth";
const MCP_OAUTH_TIMEOUT_MS = 2 * 60 * 1000;

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
 * provider login pages with COOP sever the opener link. Loopback callbacks
 * are a different origin, so we also poll oauthStatus. */
export async function connectMcpOauth(serverId: string): Promise<McpOauthResult> {
  const started = await rpc.mcp.oauth.begin({
    serverId,
    // Providers often reject non-loopback HTTP. Optional public HTTPS callback
    // (e.g. a Tailscale Funnel) can be set via VITE_MCP_OAUTH_REDIRECT_URI.
    redirectUri:
      (import.meta.env.VITE_MCP_OAUTH_REDIRECT_URI as string | undefined)?.trim() ||
      `${window.location.origin}/mcp/oauth/callback`,
  });
  if (started.status !== "authorization_required") return started.status;
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
    let statusTimer = 0;
    let timeoutTimer = 0;
    const finish = (result: McpOauthResult) => {
      if (settled) return;
      settled = true;
      window.clearInterval(pollTimer);
      window.clearInterval(statusTimer);
      window.clearTimeout(timeoutTimer);
      channel.close();
      resolve(result);
    };
    pollTimer = window.setInterval(() => {
      if (!popup.closed) return;
      void rpc.mcp.servers
        .list()
        .then((servers) => {
          const server = servers.find((entry) => entry.id === serverId);
          finish(server?.oauthStatus === "connected" ? "connected" : "cancelled");
        })
        .catch(() => finish("cancelled"));
    }, 500);
    statusTimer = window.setInterval(() => {
      void rpc.mcp.servers
        .list()
        .then((servers) => {
          const server = servers.find((entry) => entry.id === serverId);
          if (server?.oauthStatus === "connected") finish("connected");
        })
        .catch(() => undefined);
    }, 1500);
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
