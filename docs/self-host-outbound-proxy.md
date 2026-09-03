# Self-host outbound (HTTP) proxy

Operator guide for **egress** HTTP(S) proxies on restricted networks (corporate
proxy, Mainland gateway, etc.). This is a **new** doc so it does not edit the
hot `docs/self-host.md` surface.

Rakazo does **not** ship first-class `HTTP_PROXY` / `HTTPS_PROXY` Compose knobs
today. Outbound proxy is configured on the **host**, the **Docker daemon**,
and (when needed) **container env** you add yourself. Do not bake vendor CDN
or branded proxy hostnames into project defaults.

## Three different “proxies” (do not mix them)

| Kind | What it is | Where it lives |
| --- | --- | --- |
| **Outbound / egress HTTP(S) proxy** | Host or daemon forwards *outgoing* pulls and API calls | `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` (this page) |
| **Ingress reverse proxy / TLS** | Terminates HTTPS in front of `:5173` or Caddy in prod | Host Caddy/nginx; `docs/self-host.md` published-images TLS snippet |
| **Screen proxy** | Signed `/novnc/*` capability URLs for bot desktops | `SCREEN_PROXY_SECRET` in `.env` (not an HTTP egress proxy) |

`infra/compose/docker-daemon.json` sets `"userland-proxy": false`. That is
Docker’s **NAT** path, unrelated to HTTP(S)_PROXY.

## When you need outbound proxy

Use this page when:

- Stage A/B installer curls to `raw.githubusercontent.com` (or your
  `RAKAZO_INSTALLER_URL` / `RAKAZO_DOWNLOAD_BASE` mirror) fail without a
  corporate proxy, **or**
- Stage C `docker compose … pull` cannot reach GHCR / Hub except through a
  proxy, **or**
- The running API/worker must reach model providers (e.g. OpenRouter) only via
  an egress proxy.

If the failure is “registry unreachable” and you already have a **registry
mirror**, prefer image/env overrides (`RAKAZO_*_IMAGE*`, `POSTGRES_IMAGE`,
`BUSYBOX_IMAGE`) or daemon `registry-mirrors`. See restricted-network docs /
pull-diagnostics when present. Outbound proxy and registry mirrors solve
different problems; you may need both.

## 1. Host shell (installer Stage A / B)

`install-images.sh` uses `curl`. Export proxy vars in the same shell before
running it (values are examples; use your gateway):

```bash
export HTTP_PROXY=http://proxy.example.com:8080
export HTTPS_PROXY=http://proxy.example.com:8080
# Keep loopback and internal Compose DNS off the proxy:
export NO_PROXY=localhost,127.0.0.1,::1,postgres,api,web,worker,supervisor,updater
mkdir -p rakazo && cd rakazo
curl -fsSLO "${RAKAZO_INSTALLER_URL:-https://raw.githubusercontent.com/elie222/rakazo/main/infra/compose/install-images.sh}"
bash install-images.sh
```

Notes:

- Prefer `https://` mirrors via `RAKAZO_INSTALLER_URL` /
  `RAKAZO_DOWNLOAD_BASE` when the blocker is GitHub raw reachability, not
  “must traverse a forward proxy”.
- Do not commit proxy URLs or credentials into the repo or into tracked
  `.env` examples.

## 2. Docker daemon (image pulls / Stage C)

Compose `pull` talks to the **daemon**. Shell `HTTP_PROXY` alone often does
**not** affect `docker pull`. Configure the daemon (systemd drop-in on Linux
is typical):

```bash
# Example only; paths vary by distro.
sudo mkdir -p /etc/systemd/system/docker.service.d
sudo tee /etc/systemd/system/docker.service.d/http-proxy.conf >/dev/null <<'UNIT'
[Service]
Environment="HTTP_PROXY=http://proxy.example.com:8080"
Environment="HTTPS_PROXY=http://proxy.example.com:8080"
Environment="NO_PROXY=localhost,127.0.0.1,::1"
UNIT
sudo systemctl daemon-reload
sudo systemctl restart docker
```

Then retry:

```bash
docker compose --env-file .env -f docker-compose.images.yml pull
```

Alternatively, some sites put `"proxies": { "http-proxy": "…", "https-proxy": "…", "no-proxy": "…" }`
in `/etc/docker/daemon.json`. If you also use
`infra/compose/docker-daemon.json` / `registry-mirrors` fragments, **merge**
keys carefully. Invalid JSON prevents Docker from starting.

## 3. Running containers (API → providers)

Published-images Compose does not pass `HTTP_PROXY` into `api` / `worker`
by default. If bots must call external HTTPS APIs through a forward proxy,
add the same three variables under `environment:` for those services in an
**operator-owned** override file (for example `docker-compose.override.yml`
next to the install), then recreate:

```bash
docker compose --env-file .env -f docker-compose.images.yml -f docker-compose.override.yml up -d
```

Passing an explicit `-f` disables Compose’s auto-load of `docker-compose.override.yml`,
so the second `-f` is required when that override exists.

Keep `NO_PROXY` broad enough for in-stack service names (`postgres`,
`supervisor`, `api`, …) so internal traffic stays direct.

Bot **computer** containers and remote sandbox providers (E2B / Daytona /
Box) have their own egress story; host Docker proxy settings do not
automatically equal “desktop inside the computer can reach the public
internet.” Treat computer egress as a separate ops concern.

## 4. Quick verification

```bash
# Host curl via proxy (should show your gateway’s effect)
curl -fsSI https://example.com | head -n5

# Daemon can pull (after daemon proxy restart)
docker pull busybox:1

# API health (loopback; should stay on NO_PROXY)
curl -fsS http://127.0.0.1:3100/health
```

For health field meanings see `docs/self-host-health-checks.md` when that
doc is on your branch/release.

## Pitfalls

- Setting only shell `HTTP_PROXY` then wondering why `docker compose pull`
  still fails. Fix the **daemon** proxy.
- Putting the egress proxy URL into `SCREEN_PROXY_SECRET` or into Caddy
  `reverse_proxy` lines. Wrong layer.
- Proxying `127.0.0.1` / Compose service names. Breaks healthchecks and DB
  URLs; extend `NO_PROXY`.
- Hardcoding Alibaba Cloud, ghproxy, or other CDN hostnames into Rakazo defaults.
  Project policy forbids vendor CDN defaults; keep overrides in operator
  env only.
