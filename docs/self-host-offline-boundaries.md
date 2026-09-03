# Self-host offline / air-gap boundaries

What you can **pre-stage or mirror** for a restricted network, versus what still
needs **live egress** after the stack is up. New file only; does not edit
`docs/self-host.md`.

Project policy: escape hatches are **generic** HTTPS bases and registry
overrides you control. Do **not** bake vendor CDN / 镜像站 hostnames
(阿里云、腾讯云、ghproxy、npmmirror, …) into Compose, installer defaults, or
docs as recommended endpoints.

## Reality check

Rakazo is not a fully air-gapped appliance. On supported image architectures
(default `edge` tags are linux/amd64 only; arm64 needs a multi-arch release
tag or matching pre-staged images), published-images install can be made to
**bootstrap and start** with zero public GitHub/GHCR/Hub reachability *if* you
pre-place files and images. Day-2 product use (models, optional catalogs,
remote sandboxes, email, ACME) usually still needs outbound HTTPS unless you
deliberately disable those features.

Treat “offline install” and “offline operation” as separate goals.

## Install stages (what can be mirrored)

| Stage | Default touch | Offline / mirror option |
| --- | --- | --- |
| **A** - fetch `install-images.sh` | `raw.githubusercontent.com` | Pre-copy the script, or `curl` via `RAKAZO_INSTALLER_URL` (HTTPS mirror **you** host) |
| **B** - Compose YAML + `.env.images.example` | Same GitHub raw tree under `infra/compose` | `RAKAZO_DOWNLOAD_BASE` → HTTPS mirror of that directory; or `--local` / `RAKAZO_DOWNLOAD_SKIP_EXISTING=1` when files already sit in the working directory |
| **C** - images on the host | `ghcr.io/elie222/rakazo/{app,computer}` plus Hub `postgres` / `busybox` | Pull from a registry **you** control (`RAKAZO_IMAGE*` / `RAKAZO_COMPUTER_IMAGE*` and `POSTGRES_IMAGE` / `BUSYBOX_IMAGE`; prefer **digest-less** tags on mirrors), **or** `docker load` pre-staged images and start with Compose (no pull). Daemon `registry-mirrors` is an alternative for Hub only |

Installer flags that help air-gapped **bootstrap** (not day-2):

`--local` only skips GitHub file downloads when Compose/env files are already
on disk. It does **not** skip `docker compose pull`. A full installer run still
needs registry access unless you bypass the installer after prepare.

```bash
# Files already on disk next to the script:
bash install-images.sh --local --prepare-only
# edit .env (image overrides; installer wrote secrets if it created .env)
# If you already had a hand-written .env, fill required secrets before --prepare-only;
# prepare-only still validates an existing .env.
```

With images already loaded (or pointed at an internal registry you can reach),
start Compose yourself instead of re-running the installer. Compose defaults
Postgres to a digest pin; if you loaded a digest-less tag (for example
`postgres:16`), set `POSTGRES_IMAGE=postgres:16` (and `BUSYBOX_IMAGE` as
needed). App/computer refs are split: set repository and tag separately
(`RAKAZO_IMAGE` + `RAKAZO_IMAGE_TAG`, `RAKAZO_COMPUTER_IMAGE` +
`RAKAZO_COMPUTER_IMAGE_TAG`). Do not put `repo:tag` into the repository
variable; Compose appends `:${RAKAZO_IMAGE_TAG}` and a combined value becomes
`repo:tag:tag`.

```bash
docker compose --env-file .env -f docker-compose.images.yml up -d --pull never
# When your Compose plugin supports it:
# docker compose --env-file .env -f docker-compose.images.yml up -d --pull never --wait --wait-timeout 300
```

`RAKAZO_DOWNLOAD_BASE` must be `https://…` (non-HTTPS is rejected). Trailing
slashes are trimmed.

## What you can fully pre-stage

Safe to vend into the air-gap **before** cutover:

1. `install-images.sh`, `docker-compose.images.yml`, `.env.images.example`
2. OCI images for app, computer, Postgres, busybox: `docker load` or a private
   registry (this checklist is the published-images Compose path; production
   Compose with Caddy/updater is a separate staging set)
3. Operator-written `.env` with locally generated secrets (`openssl`)
4. Optional: host TLS certs / Caddyfile if you terminate TLS yourself (skip
   public ACME)

After images and Compose files are local, Stage A-C need no public GitHub.

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
containers may themselves lack egress; that is a separate network policy.

## Minimal “pull offline, run local” checklist

1. On a connected machine: save installer + Compose + env example; `docker pull`
   (or build) the four image refs you will pin; `docker save` → tape/USB.
2. On the air-gapped host: `docker load`; place Compose files; run
   `bash install-images.sh --local --prepare-only` first (creates `.env` with
   secrets when missing; if `.env` already exists, fill required secrets
   before that command). Then set `RAKAZO_IMAGE` / `RAKAZO_IMAGE_TAG` and
   `RAKAZO_COMPUTER_IMAGE` / `RAKAZO_COMPUTER_IMAGE_TAG` to the repository and
   tag you loaded (separate vars), plus `POSTGRES_IMAGE` / `BUSYBOX_IMAGE` to
   full digest-less refs if that is what you saved (or point all of them at an
   internal registry). Then
   `docker compose --env-file .env -f docker-compose.images.yml up -d --pull never`
   (add `--wait --wait-timeout 300` when Compose supports it). Do not re-run
   the installer for bring-up; it always runs `docker compose pull`.
3. Verify with `curl -fsS http://127.0.0.1:3100/health` (see health-checks doc
   when present). Expect `sandbox: "docker"` if that is your path.
4. Do **not** expect model replies until a provider route exists inside the
   boundary.

## Explicitly out of scope / forbidden defaults

- Shipping 阿里云 / DaoCloud / ghproxy / npmmirror (or any vendor) URLs as
  installer or Compose defaults
- Claiming “full air-gap including LLM” without an in-boundary model endpoint
- Editing this guide into `docs/self-host.md` while that file is a hot merge
  surface; link from ops notes instead

Related operator docs (when merged on your tree): pull diagnostics, outbound
HTTP proxy, health checks; each is a separate file so restricted-network
topics can land without colliding.
