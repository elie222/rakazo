# Apps and clients

Connect the mobile and desktop apps to your server and control push, client updates and what the
web app may load.

## Connect mobile clients

The iOS and Android app can also point at a self-hosted origin at runtime. On the sign-in screen, tap **Use a custom server** and enter the same HTTPS origin as `WEB_ORIGIN` (for example `https://app.example.com`). Store builds still default to `EXPO_PUBLIC_API_URL`; the in-app setting is an override for people running their own API. Changing the server signs the device out of any previous session.

The app accepts plain `http://` only for a private IP, `localhost`, or a `.local` name, but Docker Compose publishes the web port on loopback by default. For LAN access, follow [Connecting a phone on the same network](#connecting-a-phone-on-the-same-network). A hostname reached over a VPN such as WireGuard or Tailscale needs HTTPS with a certificate the phone trusts, for example a real domain with a Let's Encrypt certificate issued through a DNS challenge.

Native apps need a setting on the server before they can use its [passkeys](./self-host-accounts.md#passkeys).

## Connecting a phone on the same network

In the Compose stack's `.env`, set `RAKAZO_WEB_BIND=0.0.0.0` (or the host's LAN IP),
and set `WEB_ORIGIN`, `BETTER_AUTH_URL` and `API_URL` to `http://<LAN-IP>:5173`.
Replace `<LAN-IP>` with the server's LAN IP. This publishes only the web port; the API
and other ports stay on loopback. For published images, if you changed `RAKAZO_WEB_PORT`,
use that port instead of `5173` in the origins, firewall rule and app address below.
The source-build stack uses port `5173`.

Recreate the services with `docker compose up -d`, using the same Compose file and env-file
options as your install. Allow TCP port 5173 only from your LAN subnet in the host firewall,
then enter `http://<LAN-IP>:5173` in the app's **Use a custom server** field.

This exposes plain-HTTP sign-in to everyone on the local network. Tailscale or an HTTPS
reverse proxy is the safer option.

## Mobile push notifications

The API and worker send iOS and Android notifications through Expo's push service. If the Expo
project has [enhanced security for push notifications](https://docs.expo.dev/push-notifications/sending-notifications/#additional-security)
enabled, every send needs an access token; without one Expo rejects all pushes. Create an access
token in the Expo account that owns the project and set it for both services:

```env
EXPO_ACCESS_TOKEN=replace-with-your-expo-access-token
```

Leave it unset when enhanced security is off. A missing or revoked token fails the push with an
error that names `EXPO_ACCESS_TOKEN`; the token itself is never logged.

### Mobile incoming calls

Incoming calls ring in the mobile app while it is open. Registered devices also receive an
expiring high-priority push: a native call notification on Android, and a time-sensitive
notification on iOS. Android uses the existing Expo push setup (including the Firebase
configuration in the native build). Android 14 and later may deny full-screen notification
access; the call then uses a heads-up notification. Notification permissions and channel
settings still apply.

For iOS to ring while locked or backgrounded, optionally configure APNs VoIP delivery on
both the API and worker. In Apple Developer, open **Certificates, Identifiers & Profiles →
Keys**, create a key with **Apple Push Notifications service (APNs)** enabled for the app,
and download its `.p8` file. Configure these server secrets through your deployment's
normal environment/secret manager:

| Setting                 | Value                                                                              |
| ----------------------- | ---------------------------------------------------------------------------------- |
| `APNS_VOIP_KEY_ID`      | `<APNS_KEY_ID>`                                                                    |
| `APNS_VOIP_TEAM_ID`     | `<APPLE_TEAM_ID>`                                                                  |
| `APNS_VOIP_PRIVATE_KEY` | Contents of the `.p8` file; literal `\n` escapes are accepted                      |
| `APNS_VOIP_ENVIRONMENT` | `sandbox` for development signing, `production` for TestFlight/App Store (default) |
| `APNS_VOIP_BUNDLE_ID`   | Your iOS bundle identifier; defaults to `com.rakazo.app`                           |

Live Activities use the same APNs credentials for work-card updates. Self-hosters using the
App Store build do not get Live Activities: sending updates requires APNs credentials authorized
for the store bundle identifier, which self-hosters do not have. To enable them, build and sign
your own iOS app and configure the secrets above for its bundle identifier. Without server
support, the app skips starting the work card.

The adapter uses the `<bundle identifier>.voip` topic. Keep keys on the server; never put
them in the app or repository. Enable Push Notifications and Background Modes (Voice over
IP, Audio, and Remote notifications) for the iOS App ID and provisioning profile. The Expo
app config declares those modes and the time-sensitive notification capability. Development
profiles must use the matching APNs entitlement/environment. Ship a new native build;
an over-the-air JavaScript update cannot add these capabilities. PushKit registration is
independent of permission for ordinary notifications.

Without APNs configuration, or if APNs delivery fails, iOS falls back to the Expo notification.
That fallback cannot provide CallKit ringing when iOS has suspended the app. Every VoIP
push is reported immediately to CallKit in native code; an expired push is reported and
immediately ended. When the call is answered or declined elsewhere, Android devices get a
second push that stops the ring. iOS stops ringing through the open app; a VoIP push would ring
again, so a backgrounded iPhone rings until the call expires. Declining from the lock screen uses the authenticated decline endpoint.
Its session is kept in the device keychain with access after first unlock, on that device
only, so a locked phone can reject the call; sign-out clears it and revokes delivery.
Payloads contain only the call ID, bot ID/name, and expiry, never message content or credentials.

Verify locked-screen delivery, answering, declining, token rotation, and multiple-device
races on physical iOS and Android devices with the matching push credentials. Simulators
and offline unit tests cannot validate APNs delivery or operating-system push throttling.

## Client updates

Every web build is named by the UTC time it was built (`YYYYMMDDHHMMSS`). The web app sends its
build on each `/rpc` request in `x-rakazo-client-build` (`web/20261022093015`; the mobile app sends
`mobile/` and the time its JavaScript bundle was built), and the API answers with the web build in
its own image in `x-rakazo-build`. An open tab that sees a newer build reloads at a safe moment:
while hidden, on its next navigation, or after a few idle minutes with nothing typed.

To retire old clients immediately, set `RAKAZO_MIN_CLIENT_BUILD` on the API, for example
`web=20261022093015` or `web=20261022093015,mobile=20261001000000`, and restart it. Older clients
get HTTP 426 `CLIENT_UPDATE_REQUIRED`: the web app reloads, and the mobile app offers its update.
Read the current build from the `x-rakazo-build` header of any `/rpc` response. Requests that name
no build, such as webhooks and API tools, are never refused. A malformed value stops the API from
starting rather than being ignored.

## Content-Security-Policy

The web server sends a strict Content-Security-Policy: scripts and connections are limited to the
app's own origin. When a CDN in front of the app injects a script, such as an analytics beacon, the
browser blocks it until you add its origins. `RAKAZO_CSP_SCRIPT_SRC` extends `script-src` and
`RAKAZO_CSP_CONNECT_SRC` extends `connect-src`. Each takes space-separated `https://` origins, with
an optional port and leading `*.` wildcard (`https://*.example.com`). Keywords such as
`'unsafe-inline'`, bare schemes, `*`, `http://` origins and paths are rejected, and the web server
refuses to start until the value is fixed. Restart the web service after changing either one.

For example, Cloudflare Web Analytics loads its script from one host and reports to another:

```bash
RAKAZO_CSP_SCRIPT_SRC=https://static.cloudflareinsights.com
RAKAZO_CSP_CONNECT_SRC=https://cloudflareinsights.com
```

Add only origins you trust: a script these settings allow runs with the signed-in user's access.

Browsers report what the policy blocks to `/api/csp-report`. The API writes one `csp.violation`
warning per violation, with the directive, the blocked origin and the page path, so search your logs
for it to find the origins to add.

## Colors and fonts

`RAKAZO_THEME` points the web service at a JSON file that overrides the web app's colors and fonts,
including in desktop apps connected to the instance as an **Existing instance**. Leave it unset to
keep the default look. The mobile apps, and the desktop app's **This computer** server, keep the
default look either way.

```json
{
  "dark": { "background": "#1A1714", "sidebar": "#14110F", "primary": "#E8B26A" },
  "light": { "background": "#FBF7F0", "primary": "#8A4B12" },
  "radius": "6px",
  "fonts": {
    "sans": "Onest, system-ui, sans-serif",
    "mono": "ui-monospace, monospace",
    "files": [{ "family": "Onest", "file": "fonts/Onest.woff2", "weight": "100 900" }]
  }
}
```

`dark` and `light` take any of the color names in
[`packages/ui-tokens/src/index.ts`](../packages/ui-tokens/src/index.ts) (`ColorTokens` and
`WebColorTokens`) with a hex value; anything you leave out keeps its default. `sans` and `mono` are
font-family lists. `radius` is the base corner size in `px` or `rem` (default `0.75rem`); smaller
and larger corners scale from it. A font that isn't installed on every device needs its file listed under `files`
(`.woff2`, `.woff`, `.ttf` or `.otf`, relative to the theme file); the web service serves it from
your own domain. The web service re-reads the file on each page load, so a reload shows your edits.
Font files must sit inside the theme's folder. A file it can't use is skipped with a
`web.instance_theme_ignored` warning naming the problem.

With Docker Compose, mount the folder into the web service:

```yaml
# docker-compose.override.yml
services:
  web:
    volumes:
      - ./theme:/theme:ro
```

```bash
RAKAZO_THEME=/theme/theme.json
```

`install-images.sh` layers that override file automatically. Where you run Compose yourself, as in
[Production deployment](./self-host-production.md), add `-f docker-compose.override.yml` after the
base file, or the web service won't find the theme and serves the default look.

## Menu links

`RAKAZO_NAV_LINKS` adds items to the account menu that open a page from the same domain inside the
web app, such as an internal tool your reverse proxy serves next to Rakazo. Set it on the API:

```bash
RAKAZO_NAV_LINKS='[{"id":"clients","label":"Clients","path":"/ext/clients/"}]'
```

Each `id` is lowercase letters, digits and dashes, and becomes `/app/x/<id>`. `path` must start with a
single `/` and must not be under `/app`, `/api`, `/rpc`, `/novnc` or `/health`. Route it before the
catch-all in your proxy, for example `handle /ext/* { reverse_proxy office:8080 }` in
`Caddyfile.prod`. A malformed value stops the API from starting.

Pages open sandboxed with an opaque origin, so they cannot read Rakazo's pages or act with the
signed-in user's session; that also blocks their own cookies and storage. Add `"trusted": true` to a
link only for a service you control: a trusted page runs with the signed-in user's access, like a
script allowed by `RAKAZO_CSP_SCRIPT_SRC`. The page must allow framing by the app
(`frame-ancestors 'self'`). Links appear in the web app only; the desktop and mobile apps hide them.
