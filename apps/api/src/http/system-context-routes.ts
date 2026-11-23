/**
 * Requests under these paths run with a system database context, which bypasses row-level
 * security: account and session tables, signup bootstrap and account deletion span tenants, and
 * webhooks authenticate a bot or provider, then resolve the tenant from it.
 *
 * Every route under them is in SESSIONLESS_ROUTES. None scopes what it reads by a signed-in
 * user's space, so a route that does is mounted outside these paths.
 */
export const SYSTEM_CONTEXT_PATHS = [
  ["/api/auth/*", "authentication"],
  ["/api/v1/bots/*", "bot webhook"],
  ["/api/v1/email/*", "inbound email"],
  ["/api/v1/messaging/*", "messaging webhook"],
  ["/api/v1/phone/*", "messaging webhook"],
] as const;
