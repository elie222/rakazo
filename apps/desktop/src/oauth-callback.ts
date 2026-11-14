import type { RakazoDesktopOAuthCallback } from "@rakazo/contracts";

export type OAuthCallbackFromOptions = {
  /** SSO callbacks must reach the API, including a loopback API on a separate port. */
  frameName?: string;
  /** App renderer origins — their `/callback` routes must not be treated as paste-flow codes. */
  excludeOrigins?: readonly string[];
};

export const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The web app route a provider sends an MCP sign-in back to. */
export const MCP_OAUTH_CALLBACK_PATH = "/mcp/oauth/callback";

/**
 * An MCP sign-in popup has its own cookies, so the app's callback page would
 * arrive without a session. The main process takes the code from the redirect
 * instead and the app completes the sign-in itself.
 */
export function mcpOAuthCallbackFrom(
  url: string,
  appOrigin: string,
): { code: string; state: string } | { error: string } | undefined {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return undefined;
  }
  if (target.origin !== appOrigin || target.pathname !== MCP_OAUTH_CALLBACK_PATH) return undefined;
  // A refusal ends the sign-in too; its text is what the callback page would show.
  if (target.searchParams.getAll("error").length === 1) {
    const error =
      target.searchParams.get("error_description")?.trim() ||
      target.searchParams.get("error")?.trim();
    return error ? { error } : undefined;
  }
  if (target.searchParams.getAll("code").length !== 1) return undefined;
  if (target.searchParams.getAll("state").length !== 1) return undefined;
  const code = target.searchParams.get("code")?.trim();
  const state = target.searchParams.get("state")?.trim();
  return code && state ? { code, state } : undefined;
}

/**
 * Loopback-redirect providers (e.g. `http://localhost:53692/callback`) put the
 * code in a URL the address-bar-less sign-in popup cannot show, so the main
 * process reads it from the navigation instead.
 */
export function oauthCallbackFrom(
  url: string,
  options: OAuthCallbackFromOptions = {},
): RakazoDesktopOAuthCallback | undefined {
  if (options.frameName === "rakazo-sso-oauth") return undefined;
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return undefined;
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") return undefined;
  if (!LOOPBACK_HOSTS.has(target.hostname)) return undefined;
  if (options.excludeOrigins?.includes(target.origin)) return undefined;
  const code = target.searchParams.get("code")?.trim();
  if (!code) return undefined;
  const state = target.searchParams.get("state")?.trim();
  return state ? { code, state } : { code };
}
