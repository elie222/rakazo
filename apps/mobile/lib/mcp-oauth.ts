import { MOBILE_MCP_OAUTH_CALLBACK_URL } from "@rakazo/contracts";
import { rpc } from "./api";
import { t } from "./i18n";

export type McpSignIn =
  | "connected"
  | "cancelled"
  | "already_connected"
  | "authorization_not_requested";

/** Signs in to an MCP server in the in-app browser. The web callback hands the provider's
 * answer back to the app, which finishes the sign-in with its own session. */
export async function signInToMcpServer(serverId: string): Promise<McpSignIn> {
  const started = await rpc("mcp/oauth/begin", { serverId, client: "mobile" });
  if (started.status !== "authorization_required") return started.status;
  // Defer the native module, as sign-in does, so older binaries fail with a message.
  const { openAuthSessionAsync } = await import("expo-web-browser").catch(() => {
    throw new Error(t("Could not continue"));
  });
  const result = await openAuthSessionAsync(
    started.authorizationUrl,
    MOBILE_MCP_OAUTH_CALLBACK_URL,
  );
  if (result.type !== "success") return "cancelled";
  const params = new URL(result.url).searchParams;
  const code = params.get("code");
  const state = params.get("state");
  if (state !== started.sessionId) throw new Error(t("Could not continue"));
  if (params.get("error") === "access_denied") return "cancelled";
  if (!code) throw new Error(params.get("error_description") || t("Could not continue"));
  await rpc("mcp/oauth/complete", { sessionId: started.sessionId, code, state });
  return "connected";
}
