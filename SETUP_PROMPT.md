# Set up Rakazo with a coding agent

Copy the prompt below into a coding agent. It sets up the local web app first; Electron is an optional final step.

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
3. Do I want live app plugins? If yes, arrange for `COMPOSIO_API_KEY`; otherwise leave it empty. Explain that this is optional.
4. Set up the web app only (recommended), or also launch the Electron desktop shell after the web stack works?

Do not ask me to invent `BETTER_AUTH_SECRET` or `ENCRYPTION_KEY`; generate strong random local values yourself. If I choose an API key, let me enter it through an available secure secret mechanism or directly into `.env`; never echo it back. OAuth or device-code sign-in must remain under my control.

Preflight:

- Verify Git, Node.js, pnpm, Docker, and Docker Compose.
- Use Node.js 22 LTS (at least 22.12) and the repository-declared pnpm 9.15.0. Do not silently use pnpm 10 or 11: newer pnpm versions can reject this lockfile or rewrite it. Prefer Corepack; if Corepack is unavailable, use `npx --yes pnpm@9.15.0` for repo commands rather than globally installing a different version. Show the effective versions.
- Verify the Docker daemon is running.
- Check whether `127.0.0.1` ports 5433, 3100, 5173, and 7091 are available. Resolve conflicts without touching unrelated workloads.

Setup:

1. Clone the repository if needed and enter its root.
2. Read `AGENTS.md`, `README.md`, `.env.example`, and the root `package.json` before acting. Follow repository instructions if they have changed since this prompt was written.
3. If `.env` does not exist, copy `.env.example` to `.env`. Generate independent random values of at least 32 bytes for `BETTER_AUTH_SECRET` and `ENCRYPTION_KEY`. Keep local defaults for Postgres, origins, Pi, Docker, and Graphile unless the preflight found a conflict. Add only the model and Composio credentials I selected. Leave optional credentials blank.
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

- Request `http://127.0.0.1:3100/health`. Require `ok: true`, `runtime: "pi"`, `sandbox: "docker"`, `jobs: "graphile"`, and `realtime: "postgres"`. Expect `composio: true` only when its key was configured. `revision` is `null` unless `GIT_SHA` is set.
- Open `http://127.0.0.1:5173` in a browser. If browser automation is available, use it for non-sensitive steps; otherwise give me the exact UI steps.
- Create a local test account with clearly fake data, complete first-run onboarding, and create a test bot. Do not use personal data.
- If a model is connected, send a harmless test message and confirm the bot replies. If model setup was deferred, explicitly report that the stack is healthy but a first message will fail until a provider is configured; do not call the setup fully usable without that caveat.
- Open the Agent computer pane and confirm the Docker computer reaches `running` and renders its desktop.
- If Composio was not configured, confirm Plugins explains that it is not configured. If it was configured, verify the Plugins view loads without exposing the key.
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
