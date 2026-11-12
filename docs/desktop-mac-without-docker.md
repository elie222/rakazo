# Spike: This computer on a Mac without Docker

Status: spike. Nothing here changes the desktop app yet. Docker stays the only path the app uses
on every platform until the maintainer decides on the questions at the end.

Goal: on Apple silicon Macs running macOS 26 or newer, **This computer** runs Rakazo with nothing
extra to install. Docker Desktop stays the fallback on Intel Macs, older macOS, Linux and Windows.

## Summary

- The server side does not need containers. Postgres 16 runs as a native binary and the API,
  worker and web run as plain Node processes, all bound to `127.0.0.1` under the app's data
  directory. Verified on this Mac (below).
- Bot computers run as one lightweight Linux VM each through Apple's open-source `container`
  runtime (Apache 2.0, Virtualization.framework), from the **unchanged** published computer
  image. A new sandbox provider, `local-vm`, plugs into the existing `SandboxProvider` seam the
  way the Incus provider does: no supervisor, no Docker socket, screen reached on the VM's address.
  Verified end to end through the real API (below).
- Bundled size grows by roughly 120–150 MB compressed. First run is about two minutes on a fast
  connection, almost all of it downloading the computer image, which Docker users download too.
- Isolation is stronger than today: each computer gets its own kernel and VM instead of sharing
  Docker Desktop's VM, and computers sit on separate networks.

## What was run on this Mac

macOS 26.6.1 (25G76), Apple silicon (arm64). `container` was not installed, and stayed
uninstalled: everything ran from the expanded release package in a private directory, without
sudo and without the system installer.

| Step                                                        | Result                                                                                                                                                         |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `container` 1.7.1 release package (Apple-signed, notarized) | Expanded with `pkgutil`; `container system start --install-root … --app-root … --log-root …` registered user launchd agents in 45 s, including kernel download |
| Pull `ghcr.io/elie222/rakazo/computer:edge` (linux/arm64)   | 50 s, 1.58 GB unpacked                                                                                                                                         |
| First computer VM, noVNC gateway ready                      | 11 s (includes the one-time 66 MB init image); later VMs 2–3 s                                                                                                 |
| Host reaches VM screen gateway                              | `http://<vm-ip>:6080/embed.html` and per-bot `:6100` answered 200                                                                                              |
| Two computers on separate networks                          | Cannot reach each other; each reaches the internet                                                                                                             |
| VM reaching the host                                        | Host listener on `127.0.0.1` unreachable; listener on `0.0.0.0` reachable; LAN router reachable                                                                |
| `local-vm` provider, opt-in live test                       | Provisioned in 2.8 s; shared workspace contract, Chromium screenshot on the bot's display, screen URL, workspace export, stop and network cleanup all passed   |
| Postgres 16.15 native binary (embedded-postgres build)      | `initdb` 1.7 s, start < 1 s, loopback only; all Prisma and job-queue migrations plus runtime role in 6.6 s                                                     |
| API, worker, web as Node processes                          | `/internal/health` reports `sandbox: local-vm`; Graphile worker connected; web preview served and proxied the API                                              |
| Sign up, create bot, `computer.boot` through the web origin | Computer running 4 s after boot; `computer.screenUrl` issued a capability URL                                                                                  |
| Proxied screen                                              | Capability URL page served through the web proxy; its websocket returned the VNC `RFB 003.008` banner from the VM                                              |
| Persistence                                                 | File written in VM 1 survived `computer.stop` (checkpoint into `DATA_DIR/homes`) and was present in a brand-new VM 2 after `computer.boot`                     |
| Memory                                                      | One running computer with Chromium: about 970 MB host RSS (2 GB cap). Native API + worker + web + Postgres together: about 245 MB                              |

The live provider test is `VERIFY_LOCAL_VM=1 LOCAL_VM_CLI=<path to container> pnpm exec vitest run
packages/adapters/src/apple-container-sandbox.test.ts`. It is skipped by default and in CI.

Not verified: a model-driven bot run on the VM computer, the in-app screen viewer in Electron, the
terminal over the screen gateway, sleep/wake of the Mac with VMs running, Intel or macOS 15
behavior, and anything packaged or signed as part of the app.

## Server stack without Docker

| Today (Docker Compose)                 | Mac without Docker                                                                                                                    |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `postgres:16` container, named volume  | Bundled Postgres 16 binaries, cluster in `<userData>/stack/postgres`, `listen_addresses=127.0.0.1`, random port, Unix socket disabled |
| `migrate` container (`pnpm db:deploy`) | Same migration code run by Electron-as-Node before the API starts                                                                     |
| `api`, `worker` containers             | `dist/index.js` of each, run with `ELECTRON_RUN_AS_NODE=1` from the app binary (no separate Node)                                     |
| `web` container (`vite preview`)       | The built web assets plus the existing screen/API proxy, served by a small Node process on loopback                                   |
| `sandbox-supervisor` + Docker socket   | Gone. The API and worker call the bundled `container` CLI through the `local-vm` provider                                             |

A `NativeStackController` in `apps/desktop` would implement the same start/stop/state/web URL
surface as `LocalStackController`, and `setup.js` would not change: **This computer** picks the native
controller when `process.arch === "arm64"` and macOS ≥ 26, otherwise the Docker one. Electron owns
the processes (spawn, restart with backoff, stop on quit) instead of Compose. The generated
secrets, stack token and web URL files stay as they are.

Things the spike hit that the real change must handle:

- `migrate-database.ts` shells out to `pnpm` to find the Prisma package; a packaged app has no
  `pnpm`, so it needs the path passed in.
- Postgres refuses Unix socket paths over 103 bytes; disable the socket and use loopback TCP.
- `vite preview` pulls in Vite and its native dependencies at runtime. A plain Node static server
  with the existing proxy middleware is smaller and is what should ship.
- The built API is 104 MB, 77 MB of it source maps. Ship without maps or upload them to error
  reporting only.

## Bot computers

### Options considered

| Option                                                       | Verdict                                                                                                                                                                              |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Apple `container` CLI and its services, bundled              | **Recommended for v1.** Proven here, unchanged image, Apache 2.0, maintained by Apple, monthly releases. Needs only the unrestricted `com.apple.security.virtualization` entitlement |
| Own Swift helper on the Containerization framework           | Cleaner long term: one small binary, our own launchd label, no plugin layout. More code to own (image pull, networking, exec). Revisit if the CLI's services get in the way          |
| One shared Linux VM running the existing supervisor + Docker | Keeps the Docker topology, but we would ship and update a whole VM image and its Docker engine, and lose per-computer VM isolation                                                   |
| Run bot desktops on the host                                 | No. The computer is the security boundary                                                                                                                                            |
| Lima, colima, OrbStack, Podman machine                       | Each is another runtime to install or bundle, ships its own VM image, and most are not under a permissive license with a trusted vendor behind them                                  |

### The `local-vm` provider

`packages/adapters/src/apple-container-sandbox.ts` (about 400 lines, mostly delegating to the
shared `ExecComputer` and `LinuxDesktop`), selected with `SANDBOX_PROVIDER=local-vm`:

- **Provision**: a new name per start, a network of the same name, then `container run --detach
  --rm` with the bot id as a label, 2 CPUs and 2 GB by default, `--uid 1000 --gid 1000 --cap-drop
  ALL`, and the image command under `setpriv --no-new-privs`, as the Incus provider does. A stored
  running VM owned by the same bot is reused; anything else labelled for that bot is removed.
- **Exec, files, workspace**: `container exec --interactive --uid 1000` streams for the shared
  `ExecComputer`, so commands, file tools and tar import/export behave exactly as on Incus.
- **Screens and terminal**: the shared Linux desktop runtime; screen URLs point at the VM's address,
  which the host (and so the web proxy) can reach directly.
- **Persistence**: like Incus and Kubernetes, VMs are disposable and the workspace is copied in at
  boot and saved to `DATA_DIR` at the existing checkpoints. The kind is listed with the other
  server-owned-home kinds and with the terminal kinds.
- Package loaded with dynamic `import()` only when selected. No new npm dependency.

The kind name and its settings (`LOCAL_VM_CLI`, `LOCAL_VM_COMPUTER_IMAGE`, `LOCAL_VM_CPUS`,
`LOCAL_VM_MEMORY`) stay provider-neutral; only the adapter file names Apple.

Not done in the spike: an offline conformance test against a fake CLI, cancellation of a running
`container exec` beyond killing the client (the in-VM `timeout` wrapper still bounds it), a
per-user computer cap, and egress restriction (below).

## What gets bundled, and app size

| Component                                                                                       | Uncompressed | Compressed (xz) | Notes                                                    |
| ----------------------------------------------------------------------------------------------- | ------------ | --------------- | -------------------------------------------------------- |
| `container` CLI, API server, runtime, vmnet network, image store and machine API server plugins | 181 MB       | 42 MB           | Builder, cluster and build plugins left out              |
| Linux kernel for the VMs                                                                        | 30 MB        | about 10 MB     | Or downloaded on first run, as `container` does today    |
| Postgres 16 binaries                                                                            | about 110 MB | 36 MB           | Duplicate dylib copies removed; ICU is 55 MB of it       |
| API, worker, web builds and runtime dependencies                                                | about 120 MB | about 40 MB     | Without source maps; estimate, not packaged in the spike |
| Node                                                                                            | 0            | 0               | Electron runs the server code as Node                    |

That is roughly 120–150 MB more download for the Apple silicon build. Downloaded on first use and
kept under the app's data directory: the computer image (1.58 GB unpacked) and the 66 MB init
image. Docker users already download the computer image plus the app image and Docker Desktop.

## First run

Measured pieces on a fast connection: services start 2–5 s with a bundled kernel (45 s here because
the kernel was downloaded), Postgres init and migrations about 8 s, server processes about 3 s,
computer image pull about 50 s, first VM 11 s. So **about 1–2 minutes**, dominated by the image
download, which can start in the background while the user signs up because the first computer is
only needed when a bot first uses it. Later launches: about 5–10 s to a usable app; a computer
starts in 2–3 s.

## Upgrade and data directory

- Layout under `<userData>/stack`: `postgres/` (cluster), `data/` (`DATA_DIR`: homes, revisions),
  `vm/` (the runtime's app root: images, kernels, networks), plus the existing secrets and token
  files.
- App updates run migrations with the same rules as servers (the previous release must still work),
  then restart the processes. No rolling deploy is needed on one machine.
- Postgres major upgrades: keep the old major's binaries for one release and run `pg_upgrade`, the
  native equivalent of `infra/compose/upgrade-postgres.sh`. Until then pin 16, as Compose does.
- Computer image updates: the existing **Update computer** flow rebuilds from the configured image;
  the app pins the image tag of its own version.
- Docker users who upgrade: nothing moves automatically. Offer a one-time import when a Docker stack
  exists: dump the Compose database with `pg_dump` through Docker, restore it natively, copy the
  homes volume into `data/`, then leave the Docker stack stopped but intact until the user removes
  it. Computers re-provision from saved homes because the provider kind changes, which the
  lifecycle already handles.
- Rollback to Docker: the same in reverse, or keep the Docker stack untouched until the user
  confirms.

## Security and isolation compared with today

| Concern                  | Docker Desktop today                                                      | Native stack + `local-vm`                                                                               |
| ------------------------ | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Computer vs. computer    | Containers sharing one Linux VM and kernel; per-bot Docker networks       | One VM and kernel per computer; per-computer network, verified unreachable from each other              |
| Computer vs. host        | Docker Desktop VM; host services reachable through `host.docker.internal` | Host loopback unreachable (verified); services bound to `0.0.0.0` on the host and the LAN are reachable |
| Egress restriction       | Unsupported on Docker Desktop (`open`)                                    | Same: open. No host firewall rules without root                                                         |
| Privileged component     | Supervisor holds the Docker socket, root-equivalent on the Docker VM      | No socket. The API and worker can create VMs as the signed-in user, nothing more                        |
| Server processes         | Inside the Docker VM                                                      | Run as the user on the host, bound to loopback. They are our code; bot commands still only run in VMs   |
| Bundled third-party code | Docker Desktop (user-installed)                                           | Apple's `container` (Apache 2.0) and Postgres, signed and notarized with the app                        |

The native server processes do gain the user's file access. Bot commands never run on the host
unless the user turns on the existing local computer access, which is unchanged.

## What breaks or is unsupported

- Intel Macs and macOS 15 or older: Docker remains the path.
- Docker-only knobs: `SANDBOX_COMPUTER_EGRESS=restricted`, the IPv6 settings, shared host folders,
  and `SANDBOX_SCREEN_NETWORK`. Shared host folders could map to `container run --volume` later.
- Computers keep no OS changes between stops (only the workspace), as on Incus and Kubernetes.
- Requested CPUs are a soft hint: one VM reported 3 CPUs when 2 were asked.
- `container`'s services use fixed `com.apple.container.*` launchd labels. A user who also installs
  Apple's `container` would share or collide with ours.
- No API is exposed beyond loopback, so phones on the LAN cannot reach a native stack without the
  existing remote access options.

## Open questions for the maintainer

1. Ship Apple's `container` binaries (rebuilt and signed with our identity, or Apple's signed build
   inside our bundle), or invest in a small Swift helper on the Containerization framework with its
   own launchd label? Recommendation: the CLI now, the helper only if the label collision or plugin
   layout becomes a real problem.
2. Accept open egress (LAN and host `0.0.0.0` services reachable from computers) for the Mac
   path, as Docker Desktop has today? Tightening it needs a root helper or a userspace proxy.
3. Migrate existing Docker installs on Apple silicon automatically, offer it once, or only use the
   native stack for new installs?
4. Is the 120–150 MB larger Apple silicon download acceptable, or should the runtime, kernel and
   Postgres download on first choice of **This computer**?
5. Should `local-vm` also become a documented self-host provider for people running Rakazo from
   source on a Mac, or stay desktop-only?
6. Kernel: bundle the kernel `container` uses today, or build our own minimal one?
