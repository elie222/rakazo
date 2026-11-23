import { t } from "@lingui/core/macro";
import type { RpcOutput } from "@rakazo/contracts";
import { MOBILE_MCP_OAUTH_CALLBACK_URL } from "@rakazo/contracts";
import type { SaveSend } from "../query/query";

export type McpSignIn = "connected" | "cancelled" | RpcOutput<"mcp/oauth/begin">["status"];

/** Signs in to an MCP server in the in-app browser, which the web callback hands back to the app. */
export async function signInToMcpServer(send: SaveSend, serverId: string): Promise<McpSignIn> {
  return finishMcpSignIn(send, await send("mcp/oauth/begin", { serverId, client: "mobile" }));
}

/** Runs a sign-in the server started, such as one from connecting a catalog server. */
export async function finishMcpSignIn(
  send: SaveSend,
  started: RpcOutput<"mcp/oauth/begin">,
): Promise<McpSignIn> {
  if (started.status !== "authorization_required") return started.status;
  // Deferred, as sign-in does, so an older binary without the module fails with a message.
  const { openAuthSessionAsync } = await import("expo-web-browser").catch(() => {
    throw new Error(t`Could not continue`);
  });
  const result = await openAuthSessionAsync(
    started.authorizationUrl,
    MOBILE_MCP_OAUTH_CALLBACK_URL,
  );
  if (result.type !== "success") return "cancelled";
  const params = new URL(result.url).searchParams;
  const code = params.get("code");
  const state = params.get("state");
  if (!code) {
    const error = params.get("error");
    if (!error || error === "access_denied") return "cancelled";
    throw new Error(params.get("error_description") ?? t`Could not sign in`);
  }
  if (state !== started.sessionId) throw new Error(t`Could not sign in`);
  await send("mcp/oauth/complete", { sessionId: started.sessionId, code, state });
  return "connected";
}
