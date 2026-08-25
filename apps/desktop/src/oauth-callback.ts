import type { RakazoDesktopOAuthCallback } from "@rakazo/contracts";

export type OAuthCallbackFromOptions = {
  /** App renderer origins — their `/callback` routes must not be treated as paste-flow codes. */
  excludeOrigins?: readonly string[];
};

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Providers that sign in through a loopback redirect — Anthropic sends the
 * browser to `http://localhost:53692/callback` — return the authorization code
 * in the redirect URL. Rakazo runs no listener on that port and asks for the
 * code to be pasted instead, which the sign-in popup cannot show because an
 * Electron window has no address bar. The main process still sees the
 * navigation, so it reads the code from there.
 */
export function oauthCallbackFrom(
  url: string,
  options: OAuthCallbackFromOptions = {},
): RakazoDesktopOAuthCallback | undefined {
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
