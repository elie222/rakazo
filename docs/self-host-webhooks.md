# Webhooks on a private network

Many installs run on a private network (a tailnet, a LAN or a VPN), so `API_URL` is not reachable
from the internet. Outside services then cannot deliver to Rakazo: bot webhooks, Git events,
messaging apps, phone calls, meeting and calendar events, inbound email relays and billing.

Rakazo can publish only those inbound routes at a separate public address, while sign-in, the web
app and the API stay private. It is off unless you turn it on.

## Keep the main hostname private

Every certificate a public authority issues is written to public Certificate Transparency logs,
and scanners watch those logs for new names to probe. Keep the app's own hostname off the internet
and out of those logs, and give the public ingress a meaningless name that tells a scanner nothing.

## How it works

With `INGRESS_PROVIDER` set, the API opens a second port, `3101` (`INGRESS_PORT`), that answers
only inbound deliveries and returns `404` for every other path. The list of inbound routes is the
one the API already keeps of routes that answer without a session, so a new webhook is covered as
soon as it is added there. An ingress provider then forwards a public address to that port, never
to the app port.

Once a public address is published, the routine editor, a webhook routine's chat row and
`admin.js bot webhook-key` show it, and services Rakazo registers callbacks with use it. Without
one, they keep using the app's own address.

Each inbound route still checks its own caller (a bearer key, a signature or a shared secret), as it
does on the app's own address.

## Tailscale Funnel from a separate node

The bundled `tailscale-ingress` Compose service is a tailnet node of its own. It publishes only the
inbound port through [Funnel](https://tailscale.com/kb/1223/funnel), so the app's own node stays
tailnet-only.

1. In the tailnet policy, allow Funnel for the node, for example with a tag:

   ```json
   "nodeAttrs": [{ "target": ["tag:webhooks"], "attr": ["funnel"] }]
   ```

   HTTPS certificates must be on for the tailnet (DNS settings).
2. Create a reusable auth key with that tag.
3. Pick a meaningless node name, such as `q7x2m`. It becomes public, as
   `q7x2m.<tailnet>.ts.net`, and lands in certificate logs.
4. Add to `.env`, with your tailnet's DNS name from the admin console:

   ```bash
   INGRESS_PROVIDER=tailscale
   TAILSCALE_INGRESS_AUTH_KEY=tskey-auth-...
   TAILSCALE_INGRESS_HOSTNAME=q7x2m
   TAILSCALE_INGRESS_TAILNET=tail1234.ts.net
   COMPOSE_PROFILES=tailscale-ingress
   ```

   If you already use a profile, list both: `COMPOSE_PROFILES=updater,tailscale-ingress`.
5. Run `docker compose --env-file .env -f docker-compose.images.yml up -d`, then check it:

   ```bash
   docker compose --env-file .env -f docker-compose.images.yml exec api \
     node dist/cli/admin.js webhooks check
   ```

The API writes the node's serve config at startup; the node applies it whenever it changes.
`admin.js webhooks unpublish` stops forwarding until the API next starts. To turn it off for
good, unset `INGRESS_PROVIDER` and remove the profile.

## Your own tunnel or port forward

A Cloudflare Tunnel, another tunnel or a port forward on your router works the same way: forward
a public HTTPS address to the API's inbound port (`http://api:3101` from a container on the Compose
network), never to the web or app port. Then tell Rakazo the address:

```bash
INGRESS_PROVIDER=manual
INGRESS_PUBLIC_URL=https://hooks.example.com
```

Use a hostname of its own for the public address, not the app's.

## Check it

`admin.js webhooks check` prints the public address and three lines:

- **Provider**: whether the provider reports the address as published.
- **Webhook route**: whether a webhook for an unknown bot reaches this instance (it answers `401`).
- **Other paths**: whether the public address refuses everything else (it answers `404`).

It exits with status 1 when any of them fails.
