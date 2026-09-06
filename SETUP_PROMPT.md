# Set up Rakazo with a coding agent

Copy one of the prompts below into a coding agent.

## Published images (no checkout)

Prefer this when the user wants a running web UI with Docker only (no Node/pnpm clone).

```text
Set up Rakazo from published GHCR images and leave the web UI running.

Work like a careful onboarding engineer: perform the setup yourself, explain only decisions or blockers, and verify the product through the UI.

Safety rules:

- Never overwrite an existing `.env`. If one exists, inspect only which keys are present (never print values), preserve it, and ask before changing existing values.
- Never print, log, commit, or paste secrets into tracked files.
- Do not kill unrelated processes or containers to free ports. Identify conflicts and ask before stopping anything.
- Treat model or integration credentials as security-sensitive.

Before making changes, ask me these concise questions:

1. Which directory should contain the Rakazo folder (or use the current directory)?
2. How should models be connected?
   - Add a deployment-wide `OPENROUTER_API_KEY` to `.env`.
   - Connect during Rakazo onboarding with a provider API key or with ChatGPT Plus/Pro, GitHub Copilot, or SuperGrok / X Premium.
   - Defer model setup and verify infrastructure only. Make clear that bots cannot answer until a model is connected.
3. Do I want remote computers instead of local Docker? If yes, choose E2B (`E2B_API_KEY`), Daytona (`DAYTONA_API_KEY`), or Box (`BOX_API_KEY`) and set `SANDBOX_PROVIDER` accordingly. If no, keep the default `SANDBOX_PROVIDER=docker` (local computers via the in-stack supervisor).

Do not ask me to invent secrets; generate strong random values with openssl yourself.

Preflight:

- Verify Docker Engine and the Compose plugin are installed and the daemon is running.
- Check whether `127.0.0.1` ports 3100 and 5173 are available.

Setup:

1. Create the directory if needed and enter it.
2. Download and inspect this installer (do not clone the repository):
   https://raw.githubusercontent.com/elie222/rakazo/main/infra/compose/install-images.sh
   If that host is unreachable, use a mirror URL (e.g. set `RAKAZO_INSTALLER_URL` to
   `https://example.com/mirror/rakazo/infra/compose/install-images.sh` and curl that instead).
3. Run `bash install-images.sh --prepare-only`. It downloads the Compose and environment example
   files, then creates `.env` with all required random secrets when one does not already exist.
   Optional: set `RAKAZO_DOWNLOAD_BASE` to a generic mirror of `infra/compose`, and/or use
   `--local` / `RAKAZO_DOWNLOAD_SKIP_EXISTING=1` when Compose files are already present locally.
   See docs/self-host.md (Restricted networks / mirror downloads).
4. Preserve existing values. Keep `SANDBOX_PROVIDER=docker` unless I chose a remote computer
   provider, and add only the provider or model keys I selected.
5. Run `bash install-images.sh`. It preserves `.env`, pulls the images, and starts the stack.
6. Wait until api, web, and supervisor are healthy. Default image tag is `edge` (amd64 + arm64). Do not pin `latest` unless that tag exists in GHCR.

Verification:

- Request `http://127.0.0.1:3100/health`. Require `ok: true` and `sandbox: "docker"` (or the remote provider you configured). A missing `SANDBOX_SUPERVISOR_TOKEN` is a setup failure: Compose will not start the supervisor; restore the token and recreate the stack. Do not treat `sandbox: "none"` as success for this path.
- Open `http://127.0.0.1:5173`, create a local test account with fake data, and complete first-run onboarding.
- If a model is connected, send a harmless test message. Open the Agent computer pane and confirm the Docker computer reaches `running` and renders its desktop.

When finished, report the directory path, effective Docker/Compose versions, configured options without secrets, app URL, health result, and how to stop without deleting volumes (`docker compose … down` without `-v`).
```

## Local source checkout (pnpm)

Use this for development, Docker sandboxes on the host, or Electron.

```text
Set up Rakazo locally and leave it running in a usable state.

Repository: https://github.com/elie222/rakazo.git

Work like a careful onboarding engineer: perform the setup yourself, explain only decisions or blockers, and verify the product through the UI rather than stopping after dependency installation.

Safety rules:

- Never overwrite an existing `.env`. If one exists, inspect only which keys are present (never print values), preserve it, and ask before changing existing values.
- Never print, log, commit, or paste secrets into tracked files. Confirm `.env` is ignored. Do not commit anything as part of setup.
- Do not discard local changes if the repository already exists. Inspect `git status` first.
- Do not kill unrelated processes or containers to free ports. Identify conflicts and ask before stopping anything; otherwise use a safe alternate configuration and document it.
- Treat Docker/Desktop host access and model or integration credentials as security-sensitive.

Before making changes, ask me these concise questions:

1. Should you clone into the current directory, or what parent directory should contain `rakazo`? If you are already inside a Rakazo checkout, offer to use it without recloning.
2. How should models be connected?
   - Add a deployment-wide `OPENROUTER_API_KEY` to `.env`.
   - Connect during Rakazo onboarding with a provider API key or with ChatGPT Plus/Pro, GitHub Copilot, or SuperGrok / X Premium.
   - Defer model setup and verify infrastructure only. Make clear that bots cannot answer until a model is connected.
3. Do I want a managed app catalog? If yes, choose Composio (`COMPOSIO_API_KEY`) or Pipedream Connect (`PIPEDREAM_CLIENT_ID`, `PIPEDREAM_CLIENT_SECRET`, and `PIPEDREAM_PROJECT_ID`); otherwise leave them empty. Explain that this is optional and that users can still add Treg, HTTPS MCP, or OpenAPI sources in the app.
4. Set up the web app only (recommended), or also launch the Electron desktop shell after the web stack works?

Do not ask me to invent `BETTER_AUTH_SECRET` or `ENCRYPTION_KEY`; generate strong random local values yourself. If I choose an API key, let me enter it through an available secure secret mechanism or directly into `.env`; never echo it back. OAuth or device-code sign-in must remain under my control.

Preflight:

- Verify Git, Node.js, pnpm, Docker, and Docker Compose.
- Use Node.js 22.22.2 or newer in the 22.x line, Node.js 24.x, or Node.js 26+; Node.js 23.x and 25.x are not supported. Use the repository-declared pnpm 9.15.0. Do not silently use pnpm 10 or 11: newer pnpm versions can reject this lockfile or rewrite it. Prefer Corepack; if Corepack is unavailable, use `npx --yes pnpm@9.15.0` for repo commands rather than globally installing a different version. Show the effective versions.
- Verify the Docker daemon is running.
- Check whether `127.0.0.1` ports 5433, 3100, 5173, and 7091 are available. Resolve conflicts without touching unrelated workloads.

Setup:

1. Clone the repository if needed and enter its root.
2. Read `AGENTS.md`, `README.md`, `.env.example`, and the root `package.json` before acting. Follow repository instructions if they have changed since this prompt was written.
3. If `.env` does not exist, copy `.env.example` to `.env`. Generate independent random values of at least 32 bytes for `BETTER_AUTH_SECRET` and `ENCRYPTION_KEY`. Keep local defaults for Postgres, origins, Pi, Docker, and Graphile unless the preflight found a conflict. Add only the model and managed-connector credentials I selected. Leave optional credentials blank.
4. Confirm `.env` is ignored and that no secret-bearing file is staged.
5. Start only local Postgres:

   `docker compose --env-file .env -f infra/compose/docker-compose.yml up postgres -d`

6. With pnpm 9.15.0, run:

   `pnpm install --frozen-lockfile`
   `pnpm db:generate`
   `pnpm db:migrate`
   `pnpm sandbox:build`

   The first sandbox build may take several minutes because it installs a graphical Linux desktop and Chromium. If a command fails, diagnose the cause; do not bypass the lockfile or approve arbitrary dependency build scripts just to make progress.

7. Start `pnpm dev` in a persistent terminal. Wait until the API, worker, web app, and sandbox supervisor are ready. Keep the process running for me.

Verification:

- Request `http://127.0.0.1:3100/health`. Require `ok: true`, `runtime: "pi"`, `sandbox: "docker"`, `jobs: "graphile"`, and `realtime: "postgres"`. Expect `composio: true` only when its key was configured and `pipedream: true` only when all Pipedream settings were configured. `revision` is `null` unless `GIT_SHA` is set.
- Open `http://127.0.0.1:5173` in a browser. If browser automation is available, use it for non-sensitive steps; otherwise give me the exact UI steps.
- Create a local test account with clearly fake data, complete first-run onboarding, and create a test bot. Do not use personal data.
- If a model is connected, send a harmless test message and confirm the bot replies. If model setup was deferred, explicitly report that the stack is healthy but a first message will fail until a provider is configured; do not call the setup fully usable without that caveat.
- Open the Agent computer pane and confirm the Docker computer reaches `running` and renders its desktop.
- Open Integrations. If neither managed catalog was configured, confirm the view still offers Treg, HTTPS MCP, and OpenAPI sources. If one was configured, verify its app catalog loads without exposing any key or client secret.
- Run `pnpm test` and `pnpm check`. Report failures with the relevant output; do not claim success if either fails.
- If I requested Electron, leave the web stack running and then launch `pnpm --filter @rakazo/desktop dev`. Verify the shell loads the same app. Let me make the Docker-versus-This-Mac choice because This Mac grants bots access under my OS account.

When finished, report:

- The absolute repository path and checked-out commit.
- Effective Node, pnpm, Docker, and Docker Compose versions.
- Which model-auth path and optional integrations are configured, without revealing secrets.
- App URL, health result, UI/message/computer verification, and test/type-check results.
- Every workaround or remaining limitation.
- How to restart the stack.
- How to stop it without deleting data. Do not use `pnpm compose:down` for a normal stop because that script includes `-v` and removes Compose volumes; use a non-destructive stop/down command without `-v` and explain it.
```
