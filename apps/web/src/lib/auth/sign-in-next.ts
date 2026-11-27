import { isBotChatRouteId } from "@rakazo/core";

export const MCP_OAUTH_CALLBACK_PATH = "/mcp/oauth/callback";
export const SLACK_INSTALL_CALLBACK_PATH = "/messaging/slack/callback";

// The shared Pages list or a single Page review.
const PAGE_REVIEW_PATH = /^\/review(?:\/[A-Za-z0-9_-]{1,200})?\/?$/;

// A page open on its own, as a browser installs it, in the Space it belongs to.
/** A Space id as a page app's address carries it. */
export const PAGE_APP_SPACE_ID = /^[A-Za-z0-9_-]{1,200}$/;
const PAGE_APP_PATH = /^\/page\/[A-Za-z0-9_-]{1,200}(?:\?space=[A-Za-z0-9_-]{1,200})?$/;

// A Space invite link, an organization invitation's Join page, or a credit code to redeem.
const INVITE_PATH =
  /^\/(?:(?:invite|join)\/[A-Za-z0-9_-]{1,200}|redeem(?:\/[A-Za-z0-9_-]{1,64})?\/?)$/;

const BOT_CHAT_PREFIX = "/app/";

/** The page sign-in or sign-up may return to; anything else is ignored, so `next` can't redirect off the app. */
export function signInNext(next: string | null): string | null {
  if (!next) return null;
  // A connector sign-in started on another device lands here signed out; finish it after sign-in.
  if (
    next === "/integrations/setup" ||
    next === "/admin/plugins" ||
    next === "/admin/access" ||
    // The model-connection email opens the connect step.
    next === "/onboarding/model" ||
    // The agent-import email opens the import.
    next === "/app?import" ||
    next.startsWith(`${MCP_OAUTH_CALLBACK_PATH}?`) ||
    next.startsWith(`${SLACK_INSTALL_CALLBACK_PATH}?`) ||
    INVITE_PATH.test(next) ||
    (next.startsWith(BOT_CHAT_PREFIX) && isBotChatRouteId(next.slice(BOT_CHAT_PREFIX.length))) ||
    PAGE_REVIEW_PATH.test(next) ||
    PAGE_APP_PATH.test(next)
  ) {
    return next;
  }
  return null;
}

/** Where a new account starts: an invite or code it came for, otherwise onboarding. */
export function newAccountDestination(next: string | null): string {
  return next && INVITE_PATH.test(next) ? next : "/onboarding";
}
