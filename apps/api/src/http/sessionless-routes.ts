/**
 * Every raw route that answers a request with no signed-in session, with how it knows its caller.
 * RPC procedures share one sign-in step; a raw route checks its caller itself, so one that is not
 * listed here must refuse a request that carries no credentials.
 *
 * A key with a query names one branch of a route that otherwise refuses. No probe can find such a
 * branch, so a route that answers a query, header or body field before checking its caller lists
 * that branch here.
 */
export const SESSIONLESS_ROUTES: Readonly<Record<string, string>> = {
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
  "GET /api/meetings/media": "public: static meeting camera page, no session data",
  "GET /api/meetings/media/tile.css": "public: static camera tile styles",
  "GET /api/meetings/media/mark.webp": "public: static camera tile mark",
  "GET /api/meetings/media/bridge.js": "public: static camera media bridge",
  "GET /api/meetings/media/audio-worklet.js": "public: static audio worklet",
  "GET /api/meetings/media/session": "a signed expiring bearer grant scoped to one meeting",
  "POST /api/meetings/media/turn": "a signed expiring bearer grant scoped to one admitted meeting",
  "GET /api/meetings/calendar/oauth/callback":
    "a fixed mobile relay or one-time Desktop loopback state; web completion requires the initiating user",
  "GET /api/meetings/calendar/oauth/desktop":
    "a short-lived opaque state tied to the initiating Desktop sign-in session",
  "POST /api/meetings/calendar/webhook": "the calendar provider’s timestamped body signature",
  "POST /api/meetings/events": "the meeting provider’s timestamped body signature",
  "POST /api/v1/email/inbound": "the mail relay's shared secret as a bearer token",
  "ALL /api/v1/messaging/webhook/:provider": "the platform's signature, checked by its adapter",
  "GET /api/v1/messaging/install/slack/callback":
    "none: redirects to the web app, where the signed-in installer finishes; no database",
  "POST /api/v1/phone/webhook": "the platform's signature, checked by its adapter",
  "POST /api/v1/billing/webhook": "the billing provider's signature, checked by its adapter",
  "GET /api/v1/billing/return?client=mobile":
    "none: redirects to the mobile app's own link, a constant the request cannot change; no database",
  "GET /api/account/export": "a one-time token in the link, issued to the signed-in user",
  "GET /api/v1/integration-claims/confirm": "a one-time token in the emailed link",
  "GET /api/v1/pages/shared/:token": "public to anyone holding the page's share link",
  "GET /api/v1/integration-claims": "public: approved claims, read when the marketing site builds",
  "POST /api/v1/plugin-submissions": "public: anyone may submit a plugin, limited per address",
  "GET /api/v1/assets/mermaid.js": "public: a script that is the same for every caller",
  "GET /api/v1/assets/page-runtime.js": "public: a script that is the same for every caller",
  "GET /.well-known/apple-app-site-association":
    "public: the apps this domain's passkeys work in, from configuration",
  "GET /.well-known/assetlinks.json":
    "public: the apps this domain's passkeys work in, from configuration",
  "GET /api/monitoring/config": "public: where clients send error reports, from configuration",
  "POST /api/monitoring/tunnel": "public: forwards an error report to the configured project only",
  "POST /api/monitoring/native/:surface/api/0/envelope/":
    "public: forwards an error report to the configured project only",
  "POST /api/csp-report": "public: logs a browser's policy violation report, limited per address",
  "GET /api/devices/connect":
    "none: only says to upgrade; the socket is upgraded before the app, by the device's token",
  "GET /api/dev/emails": "public in development only: mail the loopback-only emulator captured",
  "GET /health": "public: liveness, a constant body",
  "GET /ready": "public: readiness, no deployment details",
  "GET /internal/health": "operators on the API port: 404 for a request the public proxy forwarded",
};
