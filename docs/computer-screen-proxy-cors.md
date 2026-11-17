# Computer screen proxy: CORS for the sandboxed noVNC embed

## Why this exists

The computer screen panel embeds the computer's `embed.html` (chrome-less noVNC) in an
iframe with `sandbox="allow-scripts allow-pointer-lock"`. Because the sandbox does not
grant `allow-same-origin`, the document runs with an opaque origin (`Origin: null`) and
every ES-module request it makes is a cross-origin request that carries side-channel
credentials. Under the fetch spec a credentialed cross-origin response can never be
accepted with the wildcard value `Access-Control-Allow-Origin: *`; the browser refuses
the module and noVNC never boots, which the panel reports as "Screen not connected".

Plain `curl` probes never hit this because they send no `Origin` header, which is why the
failure only appeared in real browsers while synthetic checks stayed green.

## Root cause and fix

`safeScreenProxyResponseHeaders` (in `@rakazo/core`) used to append
`Access-Control-Allow-Origin: *` to every screen-proxied response. It now receives the
request's `Origin` header (threaded from the web preview/screen proxy middleware) and:

- echoes an opaque origin (`Origin: null`) exactly and adds
  `Access-Control-Allow-Credentials: true`, which satisfies credentialed module loads
  from the sandboxed iframe;
- otherwise keeps the wildcard value for non-browser clients;
- always adds `Origin` to the upstream `Vary` header so shared caches never serve one
  origin's CORS answer to another.

The injected `content-security-policy` sandbox is unchanged: upstream
`allow-same-origin` policies are still refused, so the iframe cannot break out of its
opaque origin.

## Operator note: tunnel interstitials in front of the share

If the stack is exposed through a tunnel fronted by an interstitial consent page (for
example zrok), subresource requests fired from the opaque sandbox origin are classified
as cross-site for cookie-sending purposes. A `SameSite=Lax` consent cookie is therefore
not attached to them, so the interstitial can answer those requests directly (a
header-less HTML 200) before they ever reach the screen proxy, and the module loads fail
again. In that topology, have the user load the share's top-level page once (the
interstitial sets its own cookie with `SameSite=None` on that navigation) and retry the
panel; the cookie then applies to the iframe's subresources too. If this recurs for a
deployment, prefer an embedding path that keeps the screen assets same-site with the
panel rather than relaxing the interstitial.

## Verifying a deployment

With a freshly sealed screen capability URL from the app (the `/novnc/session/view/...`
embed link, do not share or commit it):

1. Fetch the embed document: expect `200`, `content-type: text/html`, the sandbox CSP,
   and `vary` including `Origin`.
2. Fetch one module URL (`clipboard-bridge.js` next to the document path) with the header
   `Origin: null`: expect `200`, `content-type: text/javascript`,
   `access-control-allow-origin: null`, and
   `access-control-allow-credentials: true`.
3. Open the panel in a real browser: the iframe should show a canvas (noVNC booted) and
   the log should show the websocket upgrade, rather than "Screen not connected".
