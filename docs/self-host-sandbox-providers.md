# Self-host sandbox / computer providers

How `SANDBOX_PROVIDER` chooses where each bot's **computer** runs. New file
only; does not edit `docs/self-host.md`.

`GET /health` reports the effective provider as `sandbox` (see
`docs/self-host-health-checks.md` when present). HTTP 200 alone is not enough:
confirm the JSON `sandbox` field matches the provider you set. A **missing**
remote key falls back to `sandbox: "none"` while `/health` still returns 200.
A present but **invalid** key still reports the chosen provider; `/health` will
not catch that until provisioning fails.

## Quick pick

| Goal | Set | Also need |
| --- | --- | --- |
| Default self-host (local Docker desktop per bot) | `SANDBOX_PROVIDER=docker` | `SANDBOX_SUPERVISOR_TOKEN`, computer image, Docker socket for supervisor |
| UI only, no computers | `SANDBOX_PROVIDER=none` | No provider credential; published-images Compose still requires `SANDBOX_SUPERVISOR_TOKEN` |
| Managed remote desktop | `e2b` / `daytona` / `box` | `SANDBOX_SUPERVISOR_TOKEN` (published-images Compose), matching API key (and optional URL knobs for Daytona/Box) |

Published-images `infra/compose/.env.images.example` defaults to **`docker`**.

## `docker` (in-stack supervisor)

Compose starts a **sandbox supervisor** (from the app image) on the internal
network (port `7091` in published-images). It creates sibling **computer**
containers from `RAKAZO_COMPUTER_IMAGE` + `RAKAZO_COMPUTER_IMAGE_TAG`.

Requirements:

- Non-empty `SANDBOX_SUPERVISOR_TOKEN` (distinct from auth / screen / encryption secrets)
- Reachable computer image (GHCR default or your mirror; on arm64 pin multi-arch tags for both app and computer)
- Docker Engine available to the supervisor (socket mount on the Compose path)

Verify:

```bash
curl -fsS http://127.0.0.1:3100/health
# expect sandbox: docker
```

Missing supervisor token is a **setup failure**: do not treat `sandbox: "none"` as success for this path.

Signup and local Docker computers work **without** an E2B (or other remote) account.

## `none`

Boots API/web without computer provisioning. Use when Docker/supervisor is
unavailable and you only need the control plane.

Published-images Compose still requires `SANDBOX_SUPERVISOR_TOKEN` and starts
the supervisor service even when `SANDBOX_PROVIDER=none`.

## Remote providers

Set `SANDBOX_PROVIDER` to exactly one of:

| Value | Credential | Notes |
| --- | --- | --- |
| `e2b` | `E2B_API_KEY` | Hosted sandboxes |
| `daytona` | `DAYTONA_API_KEY` | Optional `DAYTONA_API_URL`, `DAYTONA_TARGET` |
| `box` | `BOX_API_KEY` | Optional `BOX_API_URL` (see `.env.example`) |

Remote paths still need a working API/worker; they do not replace Postgres or
the web UI. They require egress to the provider. For air-gapped hosts prefer
`docker` with pre-loaded images, or `none`.

Published-images Compose (`docker-compose.images.yml`) still requires
`SANDBOX_SUPERVISOR_TOKEN` and always starts the supervisor service (api/worker
depend on it). The token is a Compose stack requirement; it does not replace
the remote API key.

After changing provider or keys (from the published-images drop directory that
holds `docker-compose.images.yml` and `.env`):

```bash
docker compose --env-file .env -f docker-compose.images.yml up -d
curl -fsS http://127.0.0.1:3100/health
```

Confirm `sandbox` equals the intended provider (`e2b`, `daytona`, or `box`).
HTTP 200 with `sandbox: "none"` means computers are disabled because the remote
key is missing, not a successful remote setup. A present but invalid key still
reports the chosen provider on `/health`; provisioning fails later.
