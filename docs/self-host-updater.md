# Self-host updater sidecar

Opt-in production **updater** sidecar (Compose profile `updater`).

Published-images path (`install-images.sh` / `docker-compose.images.yml`) does not include this sidecar. This page is for production Compose (`infra/compose/docker-compose.prod.yml`). For the short recipe in the main guide, see [Updater sidecar](self-host.md#updater-sidecar).

## Why it is opt-in

The updater mounts the host Docker socket (root-equivalent) and the deploy directory.
It is the process that pulls/recreates app services; it does not recreate itself.
Leave the profile disabled unless you accept that privilege boundary.

## Enable

1. Set a dedicated `RAKAZO_UPDATER_TOKEN` (≥32 chars in production), distinct from `BETTER_AUTH_SECRET`, `SANDBOX_SUPERVISOR_TOKEN`, and `SCREEN_PROXY_SECRET`.
2. Set `RAKAZO_UPDATER_URL` for the API (Compose wires `http://updater:7092` on the control network when the profile is on).
3. Ensure `RAKAZO_DEPLOY_DIR` matches the checkout path the Docker daemon sees (default `/srv/rakazo` on Linux).
4. Start with the profile, building the updater when needed:

```bash
docker compose --env-file .env -f infra/compose/docker-compose.prod.yml \
  --profile updater up -d --build updater
```

Image knobs: `RAKAZO_UPDATER_IMAGE` / `RAKAZO_UPDATER_IMAGE_TAG` (defaults `ghcr.io/elie222/rakazo/updater` + `local`). Moving the updater version is an operator action; updates do not roll the sidecar underneath itself.

## Network and exposure

- No host `ports`: nothing published on the host by default.
- Shares the Compose `control` network with the API only.
- Caddy has no public route to the updater (ingress reverse proxy must not expose it).
- `/health` on the sidecar is open (liveness); other updater routes require the shared bearer token.

## Health

Compose healthcheck hits `http://127.0.0.1:7092/health` inside the updater container.
Expect JSON shaped like `{ "ok": true, "service": "updater", ... }`.
API `/health` is separate; the public single-VM recipe checks it at `https://$RAKAZO_HOST/health` (see [Public single-VM deployment](self-host.md#public-single-vm-deployment)).

## Restricted networks

Pulling a newer app tag still needs GHCR (or your `RAKAZO_IMAGE` mirror) reachable from the daemon.
If Stage C pulls already fail, fix registry overrides first; enabling the updater does not bypass that.
See [Restricted networks / mirror downloads](self-host.md#restricted-networks--mirror-downloads).

## Related

- Token distinctness and privilege scope: [The updater's privileges](self-host.md#the-updaters-privileges)
- Sandbox / computer provider (orthogonal): [Choosing a computer provider](self-host.md#choosing-a-computer-provider)
