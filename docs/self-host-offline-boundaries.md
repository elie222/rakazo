# Self-host offline / air-gap boundaries

What you can **pre-stage or mirror** for a restricted network, versus what still
needs **live egress** after the stack is up. New file only — does not edit
`docs/self-host.md`.

Project policy: escape hatches are **generic** HTTPS bases and registry
overrides you control. Do **not** bake vendor CDN / 镜像站 hostnames
(阿里云、腾讯云、ghproxy、npmmirror, …) into Compose, installer defaults, or
docs as recommended endpoints.

## Reality check

Rakazo is not a fully air-gapped appliance. Published-images install can be
made to **bootstrap and pull** with zero public GitHub/GHCR/Hub reachability
*if* you pre-place files and images. Day-2 product use (models, optional
catalogs, remote sandboxes, email, ACME) usually still needs outbound HTTPS
unless you deliberately disable those features.

Treat “offline install” and “offline operation” as separate goals.

## Install stages (what can be mirrored)

| Stage | Default touch | Offline / mirror option |
| --- | --- | --- |
| **A** — fetch `install-images.sh` | `raw.githubusercontent.com` | Pre-copy the script, or `curl` via `RAKAZO_INSTALLER_URL` (HTTPS mirror **you** host) |
| **B** — Compose YAML + `.env.images.example` | Same GitHub raw tree under `infra/compose` | `RAKAZO_DOWNLOAD_BASE` → HTTPS mirror of that directory; or `--local` / `RAKAZO_DOWNLOAD_SKIP_EXISTING=1` when files already sit in the working directory |
| **C** — `docker compose pull` | `ghcr.io/elie222/rakazo/{app,computer}` plus Hub `postgres` / `busybox` | Pre-load images into the daemon, or override `RAKAZO_IMAGE*` / `RAKAZO_COMPUTER_IMAGE*` and `POSTGRES_IMAGE` / `BUSYBOX_IMAGE` to a registry **you** control (prefer **digest-less** tags on mirrors). Daemon `registry-mirrors` is an alternative for Hub only |

Installer flags that help air-gapped **bootstrap** (not day-2):

```bash
# Files already on disk next to the script:
bash install-images.sh --local --prepare-only
# edit .env (secrets, image overrides), then:
bash install-images.sh --local
```

`RAKAZO_DOWNLOAD_BASE` must be `https://…` (non-HTTPS is rejected). Trailing
slashes are trimmed.

## What you can fully pre-stage

Safe to vend into the air-gap **before** cutover:

1. `install-images.sh`, `docker-compose.images.yml`, `.env.images.example`
2. OCI images for app, computer, Postgres, busybox (and prod: Caddy / updater
   if you use that path) — `docker load` or a private registry
3. Operator-written `.env` with locally generated secrets (`openssl`)
4. Optional: host TLS certs / Caddyfile if you terminate TLS yourself (skip
   public ACME)

After images and Compose files are local, Stage A–C need no public GitHub.

## What still wants live network (day-2)

Even with a successful offline pull/up, these features expect egress unless
you turn them off or replace them:

| Surface | Why | Offline stance |
| --- | --- | --- |
| Model providers (`OPENROUTER_API_KEY`, onboarding OAuth to ChatGPT/Copilot/Grok, etc.) | Bot replies | Defer models; UI can come up, chats fail until a reachable provider exists |
| Remote sandboxes (`e2b` / `daytona` / `box`) | Provider APIs | Keep `SANDBOX_PROVIDER=docker` and local computer image |
| Composio / Pipedream | External catalogs | Leave keys empty |
| SMTP password recovery | Outbound mail | Leave `SMTP_URL` empty |
| Let’s Encrypt / public ACME via Caddy | Certificate issuance | Use your own certs or an internal CA |
| Updater checking GHCR for newer tags | Registry pull | Disable updater profile or point image refs at an internal registry you refresh out-of-band |
| Marketing / docs links in the UI | Browser to the public internet | Cosmetics only |

Local Docker computers (`SANDBOX_PROVIDER=docker`) still need the **computer
image** present locally; they do not need E2B. Desktops inside those
containers may themselves lack egress — that is a separate network policy.

## Minimal “pull offline, run local” checklist

1. On a connected machine: save installer + Compose + env example; `docker pull`
   (or build) the four image refs you will pin; `docker save` → tape/USB.
2. On the air-gapped host: `docker load`; place Compose files; set
   `RAKAZO_*_IMAGE*` / Hub overrides to local tags or an internal registry;
   `bash install-images.sh --local --prepare-only`; fill secrets; run without
   needing GitHub.
3. Verify with `curl -fsS http://127.0.0.1:3100/health` (see health-checks doc
   when present). Expect `sandbox: "docker"` if that is your path.
4. Do **not** expect model replies until a provider route exists inside the
   boundary.

## Explicitly out of scope / forbidden defaults

- Shipping 阿里云 / DaoCloud / ghproxy / npmmirror (or any vendor) URLs as
  installer or Compose defaults
- Claiming “full air-gap including LLM” without an in-boundary model endpoint
- Editing this guide into `docs/self-host.md` while that file is a hot merge
  surface — link from ops notes instead

Related operator docs (when merged on your tree): pull diagnostics, outbound
HTTP proxy, health checks — each is a separate file so restricted-network
topics can land without colliding.
