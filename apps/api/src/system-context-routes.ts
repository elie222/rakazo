/**
 * Requests under these paths run with a system database context, which bypasses row-level
 * security: account and session tables, signup bootstrap and account deletion span tenants, and
 * webhooks authenticate a bot or provider, then resolve the tenant from it.
 */
export const SYSTEM_CONTEXT_PATHS = [
  ["/api/auth/*", "authentication"],
  ["/api/v1/bots/*", "bot webhook"],
  ["/api/v1/email/*", "inbound email"],
  ["/api/v1/messaging/*", "messaging webhook"],
  ["/api/v1/phone/*", "messaging webhook"],
] as const;

/**
 * Every route under those paths, with how it knows its caller. None of them scopes what it reads
 * by a signed-in user's space, so a route that does is mounted outside these paths.
 */
export const SYSTEM_CONTEXT_ROUTES: Readonly<Record<string, string>> = {
  "GET /api/auth/capabilities": "public: sign-in options from configuration, no database",
  "GET /api/auth/*": "the auth library: its own credential and session checks, on account tables",
  "POST /api/auth/*": "the auth library: its own credential and session checks, on account tables",
  "GET /api/auth/scim/v2/*": "the directory's bearer token",
  "POST /api/auth/scim/v2/*": "the directory's bearer token",
  "PUT /api/auth/scim/v2/*": "the directory's bearer token",
  "PATCH /api/auth/scim/v2/*": "the directory's bearer token",
  "DELETE /api/auth/scim/v2/*": "the directory's bearer token",
  "POST /api/v1/bots/:botId/webhook": "the bot's webhook secret as a bearer token",
  "POST /api/v1/bots/:botId/github": "a body signature made with the bot's webhook secret",
  "GET /api/v1/email/unsubscribe": "a signed token in the link, bound to one user",
  "POST /api/v1/email/unsubscribe": "a signed token in the link, bound to one user",
  "POST /api/v1/email/inbound": "the mail relay's shared secret as a bearer token",
  "ALL /api/v1/messaging/webhook/:provider": "the platform's signature, checked by its adapter",
  "GET /api/v1/messaging/install/slack/callback":
    "none: redirects to the web app, where the signed-in installer finishes; no database",
  "POST /api/v1/phone/webhook": "the platform's signature, checked by its adapter",
};
