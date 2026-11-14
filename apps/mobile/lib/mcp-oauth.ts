import { t } from "@lingui/core/macro";
import type { RpcOutput } from "@rakazo/contracts";
import { MOBILE_MCP_OAUTH_CALLBACK_URL } from "@rakazo/contracts";
import { rpc } from "./api";

export type McpSignIn =
  | "connected"
  | "cancelled"
  | "already_connected"
  | "authorization_not_requested";

type SignInStart = RpcOutput<"mcp/oauth/begin">;

/** Signs in to an MCP server in the in-app browser. The web callback hands the provider's
 * answer back to the app, which passes it to the server to finish the sign-in. */
export async function signInToMcpServer(serverId: string): Promise<McpSignIn> {
  return finishMcpSignIn(await rpc("mcp/oauth/begin", { serverId, client: "mobile" }));
}

/** Runs a sign-in the server started, such as one from adding a server. */
export async function finishMcpSignIn(started: SignInStart): Promise<McpSignIn> {
  if (started.status !== "authorization_required") return started.status;
  // Defer the native module, as sign-in does, so older binaries fail with a message.
  const { openAuthSessionAsync } = await import("expo-web-browser").catch(() => {
    throw new Error(t`Could not continue`);
  });
  const result = await openAuthSessionAsync(
    started.authorizationUrl,
    MOBILE_MCP_OAUTH_CALLBACK_URL,
  );
  if (result.type !== "success") return "cancelled";
  const params = new URL(result.url).searchParams;
  const answer = {
    code: params.get("code"),
    error: params.get("error"),
    errorDescription: params.get("error_description"),
  };
  const { status } = await rpc("mcp/oauth/complete", {
    sessionId: started.sessionId,
    state: params.get("state") ?? "",
    ...Object.fromEntries(Object.entries(answer).filter(([, value]) => value)),
  });
  return status;
}
