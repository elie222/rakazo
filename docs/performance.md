# Desktop performance benchmarks

Rakazo measures the production Vite renderer inside a packaged Electron directory build against a
disposable Postgres database, the scripted agent runtime, and the fake sandbox. No provider account
or production data is used.

Run a baseline from a local Conductor workspace with Docker available:

```sh
pnpm perf:desktop -- --label=before
```

The command uses `CONDUCTOR_PORT` and the next allocated port for its web and API servers. Reports
are written to `.context/performance/<label>.json` and `.md`, which remain local to the workspace.
Override the number of cold and warm launch samples when iterating:

```sh
pnpm perf:desktop -- --label=quick --samples=2
```

To compare packaged assets with remote asset loading under a deterministic network delay:

```bash
pnpm perf:desktop -- --label=remote-80ms --asset-delay=80 --remote-renderer
pnpm perf:desktop -- --label=bundled-80ms --asset-delay=80 --skip-build
```

On macOS, compare destroy/recreate against the retained warm window with:

```bash
pnpm perf:desktop -- --label=reopen-destroyed --disable-warm-window
pnpm perf:desktop -- --label=reopen-retained --skip-build
```

After changing one performance-sensitive behavior, record another report and compare them:

```sh
pnpm perf:desktop -- --label=after
pnpm perf:compare .context/performance/before.json .context/performance/after.json
```

## Definitions

- **Cache-cold launch** uses a fresh copy of an authenticated profile and clears Chromium's HTTP and
  code caches before navigation. It is not an OS-filesystem cold start.
- **Warm launch** fully quits and relaunches Electron while preserving the primed profile and caches.
- **Shell usable** means authenticated bots and the active 100-message thread have committed and
  painted.
- **Settings painted/settled** separates React content paint from the end of the panel transition.
- **Typing** records keydown to the next animation frame with a 100-message transcript mounted.
- **Idle CPU/memory** samples every second for 12 seconds. Summed working-set memory is retained
  alongside raw per-process samples; Chromium working sets can double-count shared pages.
- **Streaming** drives the real subscription/reducer path with scripted progress every 50 ms.

Runtime CPU and launch measurements are informational until enough samples exist on a fixed Mac.
Bundle sizes are deterministic enough for automated regression checks. Keep hardware, platform, and
build mode fixed. A comparison that intentionally changes Electron or renderer mode measures the
combined migration result; it cannot attribute the change to either layer in isolation.

## Web performance scorecard

`pnpm perf:web-chat` measures the production web build against a seeded chat in headless Chromium,
offline like the desktop benchmark. Besides scrolling and streaming, it times what people feel:
first paint and a usable chat on a cold open, opening another chat, switching back to a loaded
one, opening a chat in another Space, main-thread work per keystroke and per resize step, idle
main-thread CPU, and JS heap. Each run starts with unrecorded warmups.

```sh
pnpm perf:web-chat --label=local --sizes=100 --samples=5
pnpm perf:web-chat check .context/performance/web-chat-local.json
```

`check` holds the medians of the largest thread size to fixed lines (one frame, 16 ms, for input
work; 100 ms for opening and switching) and exits non-zero when one is over. The nightly
verification workflow runs both on a GitHub-hosted Ubuntu runner, writes the table to the job
summary, and keeps the JSON report as an artifact. Desktop and mobile are not on the scorecard yet.

## Mobile

`pnpm perf:mobile-stack` starts a disposable Postgres and the offline local API, then seeds a paid
account past onboarding with 100-message chats in two Spaces. It prints the URL the app should use
and the sign-in email and password, and runs until Ctrl-C.

```sh
pnpm perf:mobile-stack
pnpm perf:mobile-stack --delay=1000
```

`--delay=<ms>` puts a small proxy in front of the API that holds every request for that long before
forwarding it, to see how the app behaves on a slow connection; responses, including the live
notification stream, pass through unchanged. `--port=<n>` moves the API (default 3120; the proxy
uses the next port).

Build a Release simulator app pointed at the printed URL, then sign in with **Password**:

```sh
EXPO_PUBLIC_API_URL=<printed URL> pnpm --filter @rakazo/mobile exec expo run:ios --configuration Release
```

Simulators run on a remote Mac. The API listens on loopback only, so run the stack on that Mac, or
forward the printed port there (`ssh -R <port>:127.0.0.1:<port> <mac>`).
