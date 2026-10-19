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
curl -fsS http://127.0.0.1:3100/internal/health
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
| `daytona` | `DAYTONA_API_KEY` | Optional `DAYTONA_API_URL`, `DAYTONA_TARGET`, `DAYTONA_SNAPSHOT` |
| `box` | `BOX_API_KEY` | Optional `BOX_API_URL` (see `.env.example`) |

Remote paths still need a working API/worker; they do not replace Postgres or
the web UI. They require egress to the provider. For air-gapped hosts prefer
`docker` with pre-loaded images, or `none`.

A run starts its computer only when it first uses a computer tool. With idle sleep on,
a computer suspends after `SANDBOX_IDLE_MS` idle. On providers that bill while running
(E2B, Daytona, Box, CreateOS, Railway), it also suspends after `COMPUTER_MAX_ACTIVE_MS`
(default 2 hours) up in one stretch, even with background work or an open screen, unless
a run is executing on it or a user is in control of its screen. `0` turns the cap off.
That exception lifts only the uptime cap; idle suspension after `SANDBOX_IDLE_MS` still
applies once nothing holds the computer.
Docker and this-Mac computers are never capped. The next use resumes it.

### E2B computer template

E2B computers start from the `rakazo-computer` template: E2B's stock desktop at
2 vCPU and 4 GB instead of its 8 vCPU and 8 GB. Build it once in the E2B team that
owns `E2B_API_KEY`, and again whenever its definition in
`packages/adapters/src/e2b-template.ts` changes:

```bash
E2B_API_KEY=<deployment key> pnpm sandbox:e2b-template
```

Until it exists, new computers use the stock desktop template. Existing computers keep
the size they were created with until they are replaced.

## Verify a provider change

After changing provider or keys (from the published-images drop directory that
holds `docker-compose.images.yml` and `.env`):

```bash
docker compose --env-file .env -f docker-compose.images.yml up -d
curl -fsS http://127.0.0.1:3100/internal/health
```

Confirm `sandbox` equals the intended provider (`e2b`, `daytona`, or `box`).
HTTP 200 alone does not verify a remote provider: a missing API key falls back to `sandbox: "none"`.
A present but invalid key still reports the selected provider. Open a bot's computer to verify
provisioning and desktop access.
