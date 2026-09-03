# Self-host health checks

How to tell a published-images or Compose deployment is actually up — without
opening `docs/self-host.md`. Escape hatches for pull failures live elsewhere
([Restricted networks](./self-host.md#restricted-networks--mirror-downloads));
this page is only probes and expected JSON.

## Quick check (published images)

After `bash install-images.sh` (or `docker compose … up -d --wait`):

```bash
curl -fsS http://127.0.0.1:3100/health
```

Expect HTTP 200 and JSON including at least:

```json
{
  "ok": true,
  "runtime": "pi",
  "sandbox": "docker",
  "jobs": "graphile",
  "realtime": "postgres"
}
```

Open the UI at [http://127.0.0.1:5173](http://127.0.0.1:5173). The Vite preview
proxies `/api` and `/rpc` to the API, **not** `/health` — use `:3100` for the
probe on the published-images path.

Installer success text points at `:5173`; Compose `--wait` already waited on
service healthchecks (Postgres, supervisor, API) when your Compose plugin
supports `--wait-timeout`.

## `GET /health` fields (API)

Implemented in `apps/api` as an unauthenticated JSON route. Useful fields:

| Field | Meaning |
| --- | --- |
| `ok` | Always `true` when the process answered. |
| `runtime` | Agent runtime (`AGENT_RUNTIME`, commonly `pi`). |
| `sandbox` | `SANDBOX_PROVIDER`: `docker`, `e2b`, `daytona`, `box`, or `none`. |
| `jobs` | Job backend id (Graphile when Postgres jobs are wired). |
| `realtime` | Realtime backend id (Postgres NOTIFY path when configured). |
| `composio` / `pipedream` / `messaging` | Booleans — optional integrations present. |
| `email` | Configured email adapter id, or `null`. |
| `revision` | `GIT_SHA` when baked in; `null` on many local/image builds. |

### Pass / fail rules of thumb

- **Published images + local Docker computers:** require `ok: true` and
  `sandbox: "docker"`. Do **not** treat `sandbox: "none"` as success for that
  path.
- Missing `SANDBOX_SUPERVISOR_TOKEN` is a setup failure: Compose will not start
  (or keep healthy) the supervisor; restore the token and recreate the stack.
- Optional keys: expect `composio: true` only when `COMPOSIO_API_KEY` is set;
  Pipedream only when its full trio is set.
- Source-checkout / prod verification often also expects `runtime: "pi"`,
  `jobs: "graphile"`, and `realtime: "postgres"` (see `SETUP_PROMPT.md`).

## Compose healthchecks (what `--wait` watches)

### Published images (`infra/compose/docker-compose.images.yml`)

| Service | Probe |
| --- | --- |
| `postgres` | `pg_isready` inside the container |
| `supervisor` | `GET http://127.0.0.1:7091/health` in-container → `{ "ok": true, "image": … }` |
| `api` | `GET http://127.0.0.1:3100/health` in-container |
| `worker` / `web` | Depend on healthy `postgres` / `api` (and supervisor where required); web has no HTTP healthcheck of its own |

Host ports (loopback): API `127.0.0.1:3100`, web `127.0.0.1:5173`. Supervisor
`7091` stays on the Compose network (not published on the host by default).

### Production Compose (`docker-compose.prod.yml`)

Same idea for Postgres + API. When the `updater` profile is enabled, the
updater sidecar exposes `GET /health` →
`{ "ok": true, "service": "updater", "image": … }` on port `7092` (internal;
authenticated routes are separate — `/health` is open so a wrong bearer can
still look “up” if you only hit health).

Caddy (`Caddyfile.prod`) reverse-proxies public `https://$RAKAZO_HOST/health`
to `api:3100`, so on a TLS VPS you can:

```bash
curl --fail https://app.example.com/health
```

## Other `/health` surfaces

| Surface | URL (typical) | Auth |
| --- | --- | --- |
| API | `http://127.0.0.1:3100/health` or public `/health` via Caddy | None |
| Sandbox supervisor | `http://supervisor:7091/health` (Compose network) | None |
| Updater sidecar | `http://updater:7092/health` | None for `/health`; other updater routes need bearer |

RPC also exposes a tiny `os.health` handler (`{ ok: true, version }`) for
in-app checks — prefer HTTP `/health` for install verification.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| `curl :3100/health` connection refused | API container not up; check `docker compose ps` / logs for `api`. |
| `ok: true` but `sandbox: "none"` | Provider left at `none`, or Docker/supervisor path not configured. |
| Compose `--wait` hangs / times out | A dependency healthcheck stays red (often Postgres, supervisor token, or API crash loop). |
| UI loads on `:5173` but `/health` returns the UI HTML | Expected on published images — Vite does not proxy `/health` (SPA fallback can be HTTP 200 HTML); use `:3100` and verify the JSON payload. |
| Public `/health` fails behind TLS | Caddy/`RAKAZO_HOST` misconfigured; confirm `handle /health` → `api:3100`. |

Stop without deleting volumes (from the published-images working directory
where the installer placed `docker-compose.images.yml`, not from a monorepo root):

```bash
docker compose --env-file .env -f docker-compose.images.yml down
```

(omit `-v`).
