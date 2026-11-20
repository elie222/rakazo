---
name: verify-rakazo
description: Start a disposable Rakazo (web app, API, worker) from this checkout with its own Postgres, an offline scripted model, and fake computers, then drive it in Chromium and keep screenshots, ARIA snapshots, traces, and database reads as evidence. Use to prove a web, API, or worker change works the way a person sees it, or when asked to run, screenshot, or check Rakazo in a browser.
---

# Verify Rakazo

The surface is the web app (`apps/web`), which Electron also hosts. It reaches the API and worker through the Vite dev proxy. Mobile (Expo) and the Electron shell itself are not covered here; see Limits.

Everything goes through `pnpm verify:stack` (`packages/testkit/src/cli/verify-stack.ts`). Read [features/README.md](features/README.md) before driving, then use the feature file that matches the change.

## Launch

Once per checkout, `pnpm install` and `pnpm db:generate`. Once per machine, `pnpm --filter @rakazo/web exec playwright install chromium`.

```sh
pnpm verify:stack up                                   # Postgres in a Docker container
pnpm verify:stack up --pg postgres://<superuser>@127.0.0.1:<port>/postgres   # no Docker
```

`--pg` (or `VERIFY_PG_URL`, which keeps a password out of the process list) takes a superuser URL for a throwaway Postgres server on this machine; anything but `127.0.0.1` or `localhost`, or a URL with query options, is refused. The run creates a database and a login named `rakazo_verify_<run>` on it and drops both, plus any branch copy, on `down`. Never point it at a server holding data you care about.

`up` starts a detached supervisor that runs the repo's own `pnpm dev` (API, worker, web, sandbox supervisor) with:

- free ports, a data dir under the run folder, and the servers connecting as a runtime login, so row-level security applies as in a deployment
- only `PATH`, `HOME`, and a few other basics from your shell, and `RAKAZO_ENV_FILE=none`, so neither your shell's variables nor a worktree's copied `.env` (real keys, `RAKAZO_DEV_RUN_WITH`, tailnet sharing, a public bind) reach the run
- the scripted model, fake computers, the cloud-agent, email, and wallet emulators, analytics off, and the real job queue, so the worker runs as it does in `pnpm dev`

It prints the web URL, the seeded account (`verify@rakazo.test` / `verify-password-1234`), and the run id. Ready means the API answers `/health`, the web server answers, and the seeded account signed up through the web proxy, which only works after every migration ran. A warm checkout is ready in about 15 seconds; a fresh one also generates the Prisma client first.

Runs are isolated by port, database, and data dir, so several can run side by side. Never drive a stack you did not start: a person's own `pnpm dev` on port 5173 uses their shared database.

## Doctor

```sh
pnpm verify:stack doctor [--run <id>]
```

Read-only. Checks the run is ready, the supervisor and `pnpm dev` are alive, the web and API ports are held by processes under this run's supervisor, `/health` answers, the web server proxies auth to the API, and every migration in the checkout is applied. Exit 1 on any failure. Run it before driving and whenever something looks off. It also prints the commit the run started at next to `HEAD`: source edits hot reload, but restart the run after a dependency change, a new migration, or an env change.

Without `--run`, commands use the newest run whose supervisor is alive.

## Drive

```sh
pnpm verify:stack drive .agents/skills/verify-rakazo/drives/chat.ts [--run <id>] [--headed]
```

A drive script default-exports one async function that receives a `Drive` (the type is in `verify-stack.ts`; skill files may not import testkit, so scripts leave it implicit):

```ts
export default async function ({ page, expect, capture, signIn }) {
  await signIn(); // the seeded account, then /app
  await page.getByPlaceholder("Message Chief").fill("hello");
  await page.keyboard.press("Enter");
  await expect(page.getByText("done. i handled: hello")).toBeVisible({ timeout: 30_000 });
  await capture("replied");
}
```

- `page`, `context`, `expect`: Playwright, with `baseURL` set to the run's web URL and a 1440x900 viewport.
- `signIn()`: signs in the seeded account through the auth API and opens `/app`. Use it as setup, not as proof of sign-in.
- `signUp()`: creates a new account through the sign-up form, as a person would, and returns its email and password.
- `capture(name)`: saves `<name>.png` and `<name>.aria.txt`.
- `emails()`: mail the email emulator captured (verification codes, invites).
- `run`, `dir`: the run's state and this drive's evidence folder.

`drives/` holds one proven script per mapped feature. For a one-off check, write the script under `verify-report/<run>/`. Prefer placeholders, roles, accessible names, and `data-testid` over CSS and position. `apps/web/e2e/` and `apps/web/e2e/helpers/helpers.ts` show the selectors for most screens.

The scripted model answers an ordinary message with "on it. i will work this in the background and come back with a result." and then "done. i handled: <message>". Certain phrases trigger scripted tool calls, cards, and failures; they are in `packages/adapters/src/runtime/scripted-runtime.ts`.

## Evidence

Each drive writes `verify-report/<run>/drives/<script>-<time>/` (gitignored):

- the named captures, plus `final.png` and `final.aria.txt`, taken even when the drive fails
- `console.txt`: browser console errors, warnings, and uncaught page errors
- `trace.zip`: open with `pnpm --filter @rakazo/web exec playwright show-trace <path>`

Server logs for every service are in `verify-report/<run>/dev.log`; the supervisor's in `stack.log`.

Capture before and after the action. Prove a change persisted with a reload or a second view, not a toast. Check side effects in the database with one read-only statement, run on whichever database the servers use (a branch with new migrations gets a copy). Tables are mostly lowercase plurals (`bots`, `spaces`, `messages`, but `"user"`), and columns keep Prisma's camelCase names, so quote them. Message text is encrypted, so check its rows, not its words.

```sh
pnpm verify:stack sql 'select name from bots order by "createdAt" desc limit 5'
```

Attach the screenshots that show a change to its PR, as `pr-watch` describes.

## Cleanup

```sh
pnpm verify:stack down [--run <id>]
```

Signals the supervisor by PID. It stops every process under its `pnpm dev`, drops the database or stops the container, and deletes the data dir. `verify-report/<run>/` stays with the logs, `state.json`, and every drive's evidence. Run `down` after a failed attempt too. If a supervisor died and left servers behind, `state.json` holds `supervisorPid` and `devPid`; stop those trees by PID, never by process name, since other checkouts run `pnpm dev` as well.

## Limits

- Real models, computers, integrations, messaging apps, and billing are emulated or off. A change to how a real provider behaves needs that provider's own conformance tests.
- Mobile needs the Expo app against an API; `pnpm perf:mobile-stack` serves one, and devices go through the T3 device tools. Electron-only behavior (windows, IPC, updates) needs the desktop app.
- `pnpm test:e2e` is CI's job (see AGENTS.md). This stack is for driving a change by hand.
