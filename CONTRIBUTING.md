# Contributing to Rakazo

Thanks for helping improve Rakazo. Keep changes focused and testable.

## Run locally

Follow the [source checkout setup](README.md#local-development-source-checkout) for prerequisites,
required secrets, and startup commands.

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

CI runs `pnpm lint`, `pnpm check`, production builds (including Electron preload smoke), `pnpm test`, `pnpm test:integration`, and `pnpm test:e2e` on every PR.

See [agent verification](docs/agent-verification.md) for the distinction between
deterministic execution tests, computer replay, and real-model quality evals.

## Optional live-provider checks

The default Playwright suite uses the fake sandbox. To run the same scripted-agent suite against
real computers, set the matching `E2B_API_KEY`, `DAYTONA_API_KEY`, or `BOX_API_KEY` and choose a provider:

```bash
pnpm test:e2e -- --sandbox=e2b
pnpm test:e2e -- --sandbox=daytona
pnpm test:e2e -- --sandbox=box
```

The Playwright workflow also accepts these providers through its manual **Sandbox provider** input.
These runs provision real machines and destroy them after the suite. Automatic runs use `fake`.
For the separate real-model desktop acceptance test, see
[computer verification](docs/computer-runtime.md#verification).

## Secrets and configuration

- **Never** commit `.env` files or secrets.
- **Never** paste API keys, tokens, or passwords in issues or PRs.
- Use placeholders in examples (`your-openrouter-key`, etc.).

The product path is **Pi + Docker + Graphile**. Emulator settings (`AGENT_RUNTIME=scripted`, `SANDBOX_PROVIDER=fake`, `WAKEUP_DRIVER=memory`) are for tests only.

**Integrations** can use [Composio](https://composio.dev/) or Pipedream Connect as optional managed
app catalogs. Users can also install HTTPS MCP servers (including Treg) and bounded OpenAPI tool
sources. Connector tests must stay deterministic and offline. Never put connector credentials in
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
