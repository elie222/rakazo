# Self-host sandbox / computer providers

`SANDBOX_PROVIDER` selects where bot computers run. Workspace bots share a Team Computer by
default; Private Computers are optional. See [computer runtime and isolation](./computer-runtime.md)
for the sharing and persistence contract.

## Quick pick

| Goal | Set | Also need |
| --- | --- | --- |
| Local Docker computers | `SANDBOX_PROVIDER=docker` | `SANDBOX_SUPERVISOR_TOKEN`, computer image, Docker socket for supervisor |
| UI only, no computers | `SANDBOX_PROVIDER=none` | No provider credential; published-images Compose still requires `SANDBOX_SUPERVISOR_TOKEN` |
| Managed remote desktop | `e2b` / `daytona` / `box` | `SANDBOX_SUPERVISOR_TOKEN` (published-images Compose), matching API key (and optional URL knobs for Daytona/Box) |

Published-images [Compose](../infra/compose/docker-compose.images.yml) defaults to **`docker`**.
It always starts the supervisor and requires `SANDBOX_SUPERVISOR_TOKEN`, including for `none`
and remote providers. This stack credential does not replace a remote provider's API key.

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

Runs API/web without provisioning bot computers.

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

## Verify a provider change

After changing provider or keys (from the published-images drop directory that
holds `docker-compose.images.yml` and `.env`):

```bash
docker compose --env-file .env -f docker-compose.images.yml up -d
curl -fsS http://127.0.0.1:3100/health
```

Confirm `sandbox` equals the intended provider (`e2b`, `daytona`, or `box`).
HTTP 200 alone does not verify a remote provider: a missing API key falls back to `sandbox: "none"`.
A present but invalid key still reports the selected provider. Open a bot's computer to verify
provisioning and desktop access.
