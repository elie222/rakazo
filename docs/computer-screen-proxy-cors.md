# Computer screen proxy and the opaque sandbox origin

The live computer screen is a noVNC page loaded inside a sandboxed iframe
(`sandbox allow-scripts allow-pointer-lock`). A sandboxed page without
`allow-same-origin` runs with the opaque origin `null`, and every asset that
page imports resolves relative to the proxy route, so each module script is a
cross-origin request that must pass the browser's CORS check before it runs.

## Why the screen can stay blank

The screen embed imports its JavaScript modules (for example the keyboard and
clipboard bridges and noVNC core) as ES modules. When the web server answered
those module requests with `Access-Control-Allow-Origin: *`, the check failed,
because the page sends requests with credentials and a wildcard origin cannot
answer a credentialed request. Chromium reports this as
`net::ERR_FAILED` on the module fetch and logs "Access to script at ... has
been blocked by CORS policy". The module never runs, so the page never opens
its WebSocket to websockify and the surrounding app shows
"Could not connect to the computer screen" even though the desktop, the screen
gateway, and the WebSocket transport are all healthy.

Requests without browser `Origin` headers (for example curl, mobile WebView
probes, or synthetic WebSocket clients) used to bypass the bug entirely, which
made the failure hard to reproduce with anything but a real browser.

This can affect self-hosted deployments and any environment where the screen
route runs behind an access proxy (zrok, Cloudflare Access, or similar), since
those proxies forward the browser's `Origin` header to the web server.

## The fix

`safeScreenProxyResponseHeaders` now takes the request's `Origin` header:

- For a sandboxed screen document (`Origin: null`) the module scripts answer
  with `Access-Control-Allow-Origin: null` and
  `Access-Control-Allow-Credentials: true`.
- Every other request keeps `Access-Control-Allow-Origin: *`.
- All screen answers add `Vary: Origin` so caches never reuse the wildcard
  answer for the sandboxed one, in front of any `Vary` the upstream sent.

The preview middleware passes the incoming request's `Origin` along. Requests
that skip the browser entirely still take the wildcard path.

## Verifying a deployment

1. Open a computer screen in the app and open browser devtools on the
   network tab while filtering for `novnc/session`.
2. The document request should answer with `text/html`, and the module
   requests with `text/javascript`.
3. With the `Origin: null` request header, the module responses must carry
   `Access-Control-Allow-Origin: null` (and before the fix they carried only
   a wildcard or nothing usable).
4. The websocket request under the same route must upgrade (`101`) and the
   screen should paint.

A deployment still showing the error after a proxy restart is likely running
an app image built before this fix; check the image build date before
debugging further. Proxy-level details such as rotating share URLs are
deployment-specific and out of scope for this page.
