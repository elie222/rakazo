# Contributing to Rakazo

Thanks for helping improve Rakazo. Keep changes focused and testable.

## Run locally

Follow the [source checkout setup](README.md#local-development-source-checkout) for prerequisites,
required secrets, and startup commands.

For a new Git worktree, run `pnpm setup:worktree`. It copies the main checkout's local
`.env` if one exists and keeps any `.env` already in the worktree.
The main checkout is the original clone, located through `git worktree list` rather than
a fixed directory or branch name.
Worktrees attached to a bare repository skip copying because there is no original checkout.
The source must be a Git-ignored regular file; symbolic links are rejected.
Settings such as `RAKAZO_DEV_TAILNET=1` are inherited only when you enabled them locally;
the setup command does not enable sharing or change any settings. If the main checkout
has no `.env`, development uses its usual defaults.

In T3 Code, import the worktree setup action from the repository's `t3.json` in project
settings. It runs on worktree creation with T3's default timing. Existing worktrees keep their
own settings; later changes to the main `.env` are not copied automatically.
Run `pnpm install --frozen-lockfile` when you need to run or test the worktree.

## Checks before you open a PR

| Command | When to run |
| --- | --- |
| `pnpm test` | Default. Units, properties, and in-process contracts. Scripted runtime, fake sandbox, in-memory wakeup — no live connector or model-provider calls. |
| `pnpm test:integration` | Postgres via Testcontainers: product journeys, authorization, executor lifecycle, Graphile / LISTEN/NOTIFY. Needs Docker. |
| `pnpm test:e2e` | Playwright against the emulated API. Needs Docker. |
| `pnpm test:topology` | Local product-path smoke: Docker computer + Graphile worker recovery. Needs Docker. Not PR CI. |
| `pnpm test:canary` | Live provider canaries. Needs keys. Not PR CI. |
| `pnpm test:pi` | Real Pi against a local HTTP model fixture: streaming, tool round trips, failures and cancellation. No keys. |
| `pnpm test:computer-replay` | Real Pi and Docker Chromium against a local model fixture. Needs the computer image; no keys or Electron windows. |
| `pnpm test:evals --list` | List agent-quality cases. Add `--live` and a model connection to measure repeated real-model task success. |
| `pnpm test:computer` | Real vision model + E2B desktop. Needs keys; see [computer verification](docs/computer-runtime.md#verification). Not PR CI. |
| `pnpm check` | TypeScript (`tsc`) across the monorepo. |
| `pnpm lint` | Biome lint and format check. |

PR CI always runs `pnpm lint`. Typechecks and unit tests target affected packages and
their dependents unless a change requires checking all packages. Production builds
(including Electron smoke tests), Postgres integration tests, and web E2E run according to the
[changed-area classification](.github/scripts/changed-areas.sh) in the
[CI workflow](.github/workflows/ci.yml).

Ordinary test processes (`NODE_ENV=test`) do not load the checkout's `.env`.
Verification CLIs load configuration before starting isolated test processes;
live canaries explicitly enabled with `VERIFY_PROVIDERS` also opt into loading it.

## UI strings and translations

Add or change web strings in code only, with Lingui's `t` or `<Trans>`; leave the
`messages.po` catalogs alone in feature pull requests (adding a UI language, below, is the
one exception). Every production build extracts the
source strings first, so a new string shows in English until someone translates it. After a
merge to main, the
[translation catalogs workflow](.github/workflows/translation-catalogs.yml) keeps one
"Update translation catalogs" pull request in step with main. Translate by editing `msgstr`
entries on that pull request, or in a separate translation-only pull request once it merges.

## Adding a UI language

The web and Electron-hosted UI use Lingui catalogs. To add a locale, register it in
`apps/web/lingui.config.ts`, `apps/web/src/lib/ui-locale.ts`, and
`apps/web/src/lib/i18n.ts`, then run `pnpm --filter @rakazo/web intl:extract`, fill the new
`apps/web/src/locales/<locale>/messages.po` catalog, and validate it with
`pnpm --filter @rakazo/web intl:compile`. Commit the new catalog in the same pull request,
since the app imports it and the sync workflow only updates catalogs that already exist. Keep message IDs, placeholders, JSX markers, and
ICU plural branches intact; do not commit generated `*.js`/`*.mjs` catalog files.

Expo mobile has its own catalog and locale registry. Add the locale to
`apps/mobile/lib/ui-locale.ts`, add `apps/mobile/lib/locales/<locale>.ts`, and register the
catalog in `apps/mobile/lib/i18n.ts`. Web PO entries do not translate mobile automatically.
Update the locale unit tests and a UI E2E scenario for each supported surface. The marketing
homepage in `apps/www` and the native Electron setup window have separate localization paths;
scope and test those changes explicitly instead of assuming the web catalog covers them.

See [agent verification](docs/agent-verification.md) for the distinction between
deterministic execution tests, computer replay, and real-model quality evals.

## Optional live-provider checks

The default Playwright suite uses the fake sandbox. To run the same scripted-agent suite against
real computers, set the matching `E2B_API_KEY`, `NOVITA_API_KEY`, `DAYTONA_API_KEY`, `BOAT_API_KEY`, or `BOXD_API_KEY` and choose a provider:

```bash
pnpm test:e2e -- --sandbox=e2b
pnpm test:e2e -- --sandbox=novita
pnpm test:e2e -- --sandbox=daytona
pnpm test:e2e -- --sandbox=boat
pnpm test:e2e -- --sandbox=boxd
```

For Novita, build the [computer template](docs/self-host-sandbox-providers.md#novita-computer-template) first.
These runs provision real machines and destroy them after the suite. CI always uses `fake`.
For the separate real-model desktop acceptance test, see
[computer verification](docs/computer-runtime.md#verification).

## Secrets and configuration

- **Never** commit `.env` files or secrets.
- **Never** paste API keys, tokens, or passwords in issues or PRs.
- Use placeholders in examples (`your-openrouter-key`, etc.).

The product path is **Pi + Docker + Graphile**. Emulator settings (`AGENT_RUNTIME=scripted`, `SANDBOX_PROVIDER=fake`, `WAKEUP_DRIVER=memory`) are for tests only.

**Integrations** can use [Composio](https://composio.dev/) or Pipedream Connect as optional managed
app catalogs. Users can also install HTTPS MCP servers and bounded OpenAPI tool sources. Paid data
services use one deployment account behind `PaidServiceProvider`. Connector tests must stay deterministic and offline. Never put connector credentials in
capability config, fixtures, logs, or snapshots; use the encrypted secret store and fake placeholders.

## Pull requests

- Keep PRs small and easy to review.
- Target the `main` branch.
- Describe why the change is needed, what changed, and **how you tested** (e.g. `pnpm test`, manual steps).
- Link related issues when applicable.

## Contact

| Address | Use for |
| --- | --- |
| [security@rakazo.com](mailto:security@rakazo.com) | Vulnerabilities only — see [SECURITY.md](SECURITY.md) |
| [support@rakazo.com](mailto:support@rakazo.com) | User and support questions |
| [elie@rakazo.com](mailto:elie@rakazo.com) | Maintainer |
