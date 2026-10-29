export const MCP_OAUTH_CALLBACK_PATH = "/mcp/oauth/callback";

const INVITE_PATH = /^\/invite\/[A-Za-z0-9_-]{1,200}$/;

/** The page sign-in or sign-up may return to; anything else is ignored, so `next` can't redirect off the app. */
export function signInNext(next: string | null): string | null {
  if (!next) return null;
  // A connector sign-in started on another device lands here signed out; finish it after sign-in.
  if (
    next === "/integrations/setup" ||
    next === "/admin/plugins" ||
    next.startsWith(`${MCP_OAUTH_CALLBACK_PATH}?`) ||
    INVITE_PATH.test(next)
  ) {
    return next;
  }
  return null;
}
