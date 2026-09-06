# Self-host secrets checklist

Required and optional credentials for published-images and Compose deploys.

**Never commit `.env`, never paste secret values into issues/PRs, and never
overwrite an existing `.env` without an explicit backup and operator consent.**

## Published images: what the installer fills

`bash install-images.sh` (without a pre-existing `.env`) copies
`.env.images.example` and fills empty required keys with `openssl`:

| Key | Installer fill | Role |
| --- | --- | --- |
| `POSTGRES_PASSWORD` | `openssl rand -hex 16` | Postgres role password inside Compose |
| `BETTER_AUTH_SECRET` | `openssl rand -hex 32` | Auth/session signing |
| `ENCRYPTION_KEY` | `openssl rand -hex 32` | Encrypts stored credentials at rest |
| `SCREEN_PROXY_SECRET` | `openssl rand -hex 32` | Signs short-lived `/novnc/*` screen capabilities |
| `SANDBOX_SUPERVISOR_TOKEN` | `openssl rand -hex 32` | API ↔ sandbox supervisor auth |

Re-runs **preserve** an existing `.env` (they do not rotate secrets). Empty
required keys still fail closed at Compose validate time
(`${VAR:?Set … in .env}`).

Manual generation (same shapes the installer uses):

```bash
openssl rand -hex 16   # POSTGRES_PASSWORD
openssl rand -hex 32   # BETTER_AUTH_SECRET, ENCRYPTION_KEY, SCREEN_PROXY_SECRET, SANDBOX_SUPERVISOR_TOKEN
```

Source-checkout `.env.example` asks for a **64-hex** `ENCRYPTION_KEY` in
comments; published-images installer uses 32 bytes of hex (64 hex chars) via
`openssl rand -hex 32`. Prefer long independent random values either way.
Do not reuse one string across keys.

## Distinctness rules

These must be **independent** random values (do not copy-paste the same
secret into multiple keys):

- `BETTER_AUTH_SECRET`
- `ENCRYPTION_KEY`
- `SCREEN_PROXY_SECRET`
- `SANDBOX_SUPERVISOR_TOKEN`
- `RAKAZO_UPDATER_TOKEN` (only if the updater profile is enabled; ≥32 chars,
  also distinct from the four above)

Rotating `ENCRYPTION_KEY` after credentials were stored makes old ciphertext
unreadable. Keep the original key for an existing deployment unless you
intentionally wipe encrypted material.

## Optional keys (leave blank if unused)

From `.env.images.example` (images installer). Leave blank if unused:

| Key(s) | When needed |
| --- | --- |
| `OPENROUTER_API_KEY` | Deployment-wide OpenRouter models |
| `COMPOSIO_API_KEY` | Composio managed catalog |
| `E2B_API_KEY` / `DAYTONA_API_KEY` / `BOX_API_KEY` | Remote computers when `SANDBOX_PROVIDER` is not `docker` |
| `SMTP_URL` / `EMAIL_FROM` | Password-recovery email |
| Messaging tokens (Slack, Telegram, …) | Only if you enable those surfaces |

Blank optional keys are normal for a minimal published-images boot. Pipedream
Connect keys appear only in source/Compose `.env.example`, not the images
example.

## Operator workflow

```bash
bash install-images.sh --prepare-only   # creates .env + fills empties
# inspect key NAMES only if debugging; never log values
bash install-images.sh                  # pull + up; preserves .env
curl -fsS http://127.0.0.1:3100/health
```

If `sandbox` in `/health` is `"none"` or the supervisor never becomes healthy,
check that `SANDBOX_SUPERVISOR_TOKEN` is set and non-empty for the Docker
computer path. A missing token is a setup failure, not an "optional tighten
later" item.

## Recovery without reprinting secrets

- Lost UI password: use SMTP recovery if configured; otherwise operator
  identity recovery is out of band (DB). Prefer not to rotate
  `BETTER_AUTH_SECRET` casually on a live deploy.
- Lost `.env`: from backup only. Recreating random secrets on a volume that
  still holds Postgres data will desynchronize passwords and encryption.
- Moving hosts: copy `.env` and volumes together; treat `.env` as secret
  material in transit.

## Related

- [Self-hosting](./self-host.md)
