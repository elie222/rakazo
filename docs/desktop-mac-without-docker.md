# This computer on a Mac without Docker

Status: built in `apps/desktop` (`native-stack.ts`, `mac-runtime.ts`, `docker-move.ts`). On Apple
silicon Macs with macOS 26 or newer, release builds that name a server bundle run **This computer**
without Docker; every other platform, and any build without a server bundle, keeps the Docker path
unchanged.

## Summary

- The server side does not need Docker. The API, worker and web run as plain Node processes bound
  to `127.0.0.1`, and the database is the official `postgres:16` image, at the digest Compose pins,
  running as a VM of its own through the same computer runtime and published on `127.0.0.1` only.
  Verified on this Mac (below).
- Bot computers run as one lightweight Linux VM each through Apple's open-source `container`
  runtime (Apache 2.0, Virtualization.framework), from the **unchanged** published computer
  image. A new sandbox provider, `local-vm`, plugs into the existing `SandboxProvider` seam the
  way the Incus provider does: no supervisor, no Docker socket, screen reached on the VM's address.
  Verified end to end through the real API (below).
- Nothing is bundled: the app download does not grow. The server bundle and (unless the person
  already runs one) the computer runtime are downloaded, pinned by size and SHA-256, and the
  database image is pulled by digest, only when **This computer** is chosen. First start measured
  below at about a minute plus the computer runtime download; later starts take about 5 seconds.
- Isolation is stronger than today: each computer gets its own kernel and VM instead of sharing
  Docker Desktop's VM, sits on its own network, and a firewall inside the VM keeps anything running
  on it away from the Mac, the local network and other computers. It still reaches the internet.

## What was run on this Mac

macOS 26.6.1 (25G76), Apple silicon (arm64). `container` was not installed, and stayed
uninstalled: everything ran from the expanded release package in a private directory, without
sudo and without the system installer. The first rows were measured before the in-VM firewall
existed; the egress row shows the result with it.

| Step                                                        | Result                                                                                                                                                               |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `container` 1.7.1 release package (Apple-signed, notarized) | Expanded with `pkgutil`; `container system start --install-root … --app-root … --log-root …` registered user launchd agents in 45 s, including kernel download       |
| Pull `ghcr.io/elie222/rakazo/computer:edge` (linux/arm64)   | 50 s, 1.58 GB unpacked                                                                                                                                               |
| First computer VM, noVNC gateway ready                      | 11 s (includes the one-time 66 MB init image); later VMs 2–3 s                                                                                                       |
| Host reaches VM screen gateway                              | `http://<vm-ip>:6080/embed.html` and per-bot `:6100` answered 200                                                                                                    |
| Two computers on separate networks                          | Cannot reach each other; each reaches the internet                                                                                                                   |
| VM reaching the host                                        | With the firewall: host listeners on `127.0.0.1` and `0.0.0.0` and the LAN router refused; internet, DNS and SSH to github.com work; uid 1000 cannot flush the rules |
| `local-vm` provider, opt-in live test                       | Provisioned in 2.8 s; shared workspace contract, Chromium screenshot on the bot's display, screen URL, workspace export, stop and network cleanup all passed         |
| Official `postgres:16` image as a VM (Compose's digest)     | Pull of the linux/arm64 variant only: 25 s, 151.5 MB, 452 MB unpacked. First start with init about 3 s, restarts about 2 s; published on `127.0.0.1` only            |
| Desktop controller end to end (Node, scratch runtime)       | First start 64 s; sign-up and bot creation; restart 4.6 s with data intact; DB VM killed while ready recovered in 3.4 s; taken DB port recreated the VM, data intact |
| API, worker, web as Node processes                          | `/internal/health` reports `sandbox: local-vm`; Graphile worker connected; web preview served and proxied the API                                                    |
| Sign up, create bot, `computer.boot` through the web origin | Computer running 4 s after boot; `computer.screenUrl` issued a capability URL                                                                                        |
| Proxied screen                                              | Capability URL page served through the web proxy; its websocket returned the VNC `RFB 003.008` banner from the VM                                                    |
| Persistence                                                 | File written in VM 1 survived `computer.stop` (checkpoint into `DATA_DIR/homes`) and was present in a brand-new VM 2 after `computer.boot`                           |
| Memory                                                      | One computer with Chromium: about 970 MB host RSS (2 GB cap). Database VM: about 540 MB (1 GB cap). API + worker + web: under 245 MB (measured with native Postgres) |

The live provider test is `VERIFY_LOCAL_VM=1 LOCAL_VM_CLI=<path to container> pnpm exec vitest run
packages/adapters/src/apple-container-sandbox.test.ts`. It is skipped by default and in CI.

Not verified: a model-driven bot run on the VM computer, the in-app screen viewer in Electron, the
terminal over the screen gateway, sleep/wake of the Mac with VMs running, Intel or macOS 15
behavior, and anything packaged or signed as part of the app.

## Server stack without Docker

| Today (Docker Compose)                 | Mac without Docker                                                                                                                      |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `postgres:16` container, named volume  | The same image and digest as a VM through the computer runtime: `rakazo-postgres` VM, network and volume, 1 GB, `127.0.0.1:<port>` only |
| `migrate` container (`pnpm db:deploy`) | Same migration code run by Electron-as-Node before the API starts                                                                       |
| `api`, `worker` containers             | `dist/index.js` of each, run with `ELECTRON_RUN_AS_NODE=1` from the app binary (no separate Node)                                       |
| `web` container (`vite preview`)       | The built web assets plus the existing screen/API proxy, served by a small Node process on loopback                                     |
| `sandbox-supervisor` + Docker socket   | Gone. The API and worker call the `container` CLI (theirs or downloaded) through the `local-vm` provider                                |

### How the desktop app runs it

`main.ts` picks the controller once per launch. `NativeStackController` has the same surface as the
Docker `LocalStackController` (`webUrl`, `state`, `start`, `stop`, `abort`, `matchesDesiredStack`)
and pushes the same events, so the setup screen renders it unchanged: downloads report bytes per
component in the `pulling` phase, and milestones and migration output appear as output lines.

A start, in order:

1. Shares the Docker path's `.env` (generated secrets, the person's own settings), stack token and
   web URL file in `<userData>/stack`, and stops processes a crashed launch left behind (recorded in
   `run/*.pid` and checked against their command line; the database last).
2. In parallel: the server bundle (`server-bundle.json` in the app's resources;
   `RAKAZO_SERVER_BUNDLE=<local .tar.xz>` in unpackaged builds) and the computer runtime (below),
   then the database image through that runtime (by digest, `--platform linux/arm64`, only when it
   is missing). Each download streams to a temporary file, is checked for size and SHA-256, and only
   then unpacked into a scratch folder that is renamed to `runtime/<name>-<version>`.
3. Creates the database VM once: `rakazo-postgres` on a network of its own, a volume of the same
   name with `PGDATA` in a subdirectory (the volume's root holds `lost+found`), owner and database
   `rakazo`, and `POSTGRES_PASSWORD` passed through the CLI's environment rather than its arguments.
   The saved port is kept while free; a taken one recreates the VM on a new port, keeping the
   volume. A VM a crashed launch left running is stopped first, since the runtime only attaches to
   VMs it starts. The VM then runs under `container start --attach`, so its output goes to
   `logs/postgres.log` and the app sees it stop. The start waits for the server that listens on the
   network: on a new volume the image's setup server also reports ready.
4. Runs the bundle's migrate entrypoint (owner login `rakazo` with `POSTGRES_PASSWORD`, runtime
   login `rakazo_app` with `POSTGRES_APP_PASSWORD`). The owner's name is fixed rather than read
   from `POSTGRES_USER`, so it can never be the runtime login.
5. Spawns API, worker and web with `ELECTRON_RUN_AS_NODE=1` on loopback ports. The API and worker get
   the `.env` minus Compose-only and owner-login lines (including `DATABASE_MIGRATION_URL`), plus
   `SANDBOX_PROVIDER=local-vm`, `LOCAL_VM_CLI`, `LOCAL_VM_COMPUTER_IMAGE` (the app's image tag), the stack token and the host
   computer bridge on `127.0.0.1`. The web gets only what Compose gives it. `RAKAZO_ENV_FILE=none`
   stops the server from reading any `.env` from a parent folder such as the home directory.
6. Waits for the API's `/health` and the web's authenticated stack probe, then removes unused
   runtime versions and pulls the computer image in the background.

Ports are saved in `.native-ports` (database, API, and which runtime holds the database) and
`.desktop-web-url` (web) and reused while free, so the web origin and its sign-in survive
relaunches; a taken port is replaced and saved. A process that crashes after the stack is ready,
the database VM included, restarts with backoff (1 s doubling to 30 s, reset after a minute up); a
crash during start fails the start with that process's last log lines. Output goes to
`logs/<name>.log` (the previous launch's in `<name>.previous.log`). Quitting the app stops
everything: SIGTERM, then the database VM with SIGINT, which the runtime passes to Postgres for a
fast clean shutdown, SIGKILL after a grace.

### Computer runtime resolution

Only one `container` system can run per macOS session (fixed `com.apple.container.*` launchd
labels). The app asks the registered launchd service, `/usr/local/bin/container` and its own copy:

1. A system already running at 1.7.0 or newer is used as it is, whoever started it, and nothing is
   downloaded.
2. Otherwise a person's own `/usr/local/bin/container` at 1.7.0 or newer is started with its own
   defaults.
3. Otherwise the app downloads Apple's signed installer (checked with `pkgutil --check-signature`
   for the Containerization Developer ID and notarization, then expanded without installing),
   keeps the CLI, API server and the four plugins computers need, and starts it with its own
   install, app and log roots under `<userData>/stack`.

If our copy is running and the person later installs their own, the next start stops ours and
starts theirs, unless ours holds the database; a copy of ours older than 1.7.0 is stopped and
replaced the same way. The database volume lives in the app root of the runtime that created it, so
once our copy holds it, ours is started in preference to the person's install. If the database is
missing from the running system and `.native-ports` says it lives in the other one (recorded
before anything is created, so a first start cut short part-way counts too), the start fails asking
the person to quit the running one, instead of creating an empty database. A system the
app did not start is never stopped: one older than 1.7.0 fails the start with a message asking the
person to update or quit it.

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

- **Provision**: a new name per start, a network of the same name, then `container run --detach`
  (no `--rm`, so a VM that exits stays listed and cleanup removes it with its network) with the bot id as a label, 2 CPUs and 2 GB by default, `--uid 1000 --gid 1000 --cap-drop
  ALL --cap-add CAP_NET_ADMIN`, and the image command under `setpriv --no-new-privs`, as the Incus
  provider does. A stored running VM owned by the same bot is reused; anything else labelled for
  that bot is removed.
- **Egress lockdown**: before a VM is used (fresh or reused), the provider loads an nftables table
  as root inside it and checks it is there. Outbound, the VM may reach DNS on its gateway and the
  public internet, and nothing else: not the Mac (the gateway), private, link-local, CGNAT or
  multicast ranges, nor other computers. Inbound, only the gateway (the Mac, so the web proxy) may
  reach the screen ports. `CAP_NET_ADMIN` is kept only so root can load the rules; the bot's uid
  1000 has no effective or permitted capabilities and no-new-privs stops it gaining any, so it
  cannot change them. If the rules cannot be loaded (an image without `nft`), the VM is removed and
  the start fails.
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

Offline tests drive the provider against a fake CLI. Not done: cancellation of a running
`container exec` beyond killing the client (the in-VM `timeout` wrapper still bounds it).

## What is downloaded, and when

Nothing below is in the app download. All of it is fetched the first time **This computer** starts.

| Component                                       | Download | On disk | Source                                                          |
| ----------------------------------------------- | -------- | ------- | --------------------------------------------------------------- |
| Server bundle (API, worker, web, migrations)    | 117 MB   | ~900 MB | This release's GitHub asset, pinned by `server-bundle.json`     |
| Postgres 16 image (linux/arm64)                 | 152 MB   | 452 MB  | Docker Hub through the runtime, Compose's digest pinned in code |
| Computer runtime 1.7.1 (only when none is used) | 170 MB   | 182 MB  | Apple's signed release package, pinned in code                  |
| Linux kernel for the VMs                        | ~30 MB   | ~30 MB  | Fetched by the runtime itself on its first start                |
| Computer image                                  | —        | 1.58 GB | Pulled in the background once the stack is ready                |

## First run

Measured on this Mac (fast connection) with the real downloads and a locally built bundle, against a
computer runtime that was already running:

| Run                                                                | Time to ready            |
| ------------------------------------------------------------------ | ------------------------ |
| First start (database image pull, bundle unpack, init, migrations) | 64 s                     |
| Later start                                                        | 4.6 s                    |
| Database VM killed while ready, until sign-in works again          | 3.4 s                    |
| Move from a Docker stack (dump, restore, file copy)                | 13 s (small sample data) |
| Computer runtime package: download, verify, expand                 | 47 s                     |

A first start that also downloads the runtime adds its 47 s in parallel with the other downloads,
plus the kernel download on its first start (about 45 s measured). The computer image pull
(about 50 s) runs in the background after the app is ready.

## Upgrade and data directory

- Layout under `<userData>/stack`: `data/` (`DATA_DIR`: homes, revisions), `vm/` (our runtime's
  app root: images, kernels, networks, and the database volume when ours holds it), plus the
  existing secrets and token files. With the person's own runtime, the volume lives in its app root.
- App updates run migrations with the same rules as servers (the previous release must still work),
  then restart the processes. No rolling deploy is needed on one machine.
- Postgres major upgrades: the same move as `infra/compose/upgrade-postgres.sh`, run through the
  runtime: dump every role and database from the 16 VM, restore into the new major on a new volume,
  check, then switch. Not built yet; until then the image stays pinned to 16 by digest, as in
  Compose.
- Computer image updates: the existing **Update computer** flow rebuilds from the configured image;
  the app pins the image tag of its own version.
- Docker users: when a Docker stack exists (its compose file is in the stack folder), no native
  stack exists yet (`.native-ports`), the saved setup is **This computer** and Docker answers, the
  app asks once ("Run Rakazo without Docker?" with **Move** and **Keep Docker**) and remembers the
  answer in `.desktop-stack-choice`. **Keep Docker** keeps today's path. **Move** keeps the same
  `.env` (so `BETTER_AUTH_SECRET`, `ENCRYPTION_KEY` and the other secrets carry over) and, on the
  next start, after the database VM is up and before migrations: empties the `rakazo` database,
  stops the Docker API, worker, web and supervisor, creates the `rakazo_app` role if it is missing,
  then streams `pg_dump --format=custom` from the Docker database container through the app into
  `pg_restore --no-owner --exit-on-error` in the database VM. Both run each database's own tools
  over its local socket, so no password is used and no shell runs on the Mac. It then copies `/data`
  out of the stopped API container with `docker cp` and stops the whole Docker stack without
  removing it or its volumes (best effort: a stack that does not stop cleanly is noted in the
  output and does not undo the move). Only then is the move marked done (`.docker-imported`). If
  any step fails the Docker services it stopped are started again, the Docker data is untouched and
  **Retry** runs the move again; without the marker, a move cut short by a quit or crash is rerun on
  the next start from an emptied database and copied files. If one side of the dump stream fails,
  the other is stopped at once.
- A compose file left behind by a Docker that is no longer installed does not keep the Docker
  path: the native stack starts, nothing is asked and nothing is imported. Only a move the person
  accepted imports, so reinstalling Docker later never replaces the native database. Docker that is
  installed but not running keeps the Docker path as before.
- Computers re-provision from saved homes because the provider kind changes, which the lifecycle
  already handles.
- Rollback to Docker: the Docker stack and its volumes are left in place; nothing moves back
  automatically.

## Security and isolation compared with today

| Concern               | Docker Desktop today                                                      | Native stack + `local-vm`                                                                                                                                                              |
| --------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Computer vs. computer | Containers sharing one Linux VM and kernel; per-bot Docker networks       | One VM and kernel per computer; per-computer network, verified unreachable from each other                                                                                             |
| Computer vs. host     | Docker Desktop VM; host services reachable through `host.docker.internal` | Refused by the in-VM firewall, except DNS on the gateway (verified)                                                                                                                    |
| Egress restriction    | Unsupported on Docker Desktop (`open`)                                    | Always on: public internet only, enforced inside each VM; a bot that gained root in its VM could lift it                                                                               |
| Privileged component  | Supervisor holds the Docker socket, root-equivalent on the Docker VM      | No socket. The API and worker can create VMs as the signed-in user, nothing more                                                                                                       |
| Server processes      | Inside the Docker VM                                                      | Run as the user on the host, bound to loopback. They are our code; bot commands still only run in VMs                                                                                  |
| Database              | Container on a Compose network only the server containers join            | A VM on its own network, published only on the Mac's `127.0.0.1`; computers cannot reach it. Its own egress is not firewalled (the official image has no `nft`); it runs only Postgres |
| Third-party code      | Docker Desktop (user-installed)                                           | Apple's signed `container`, pinned by SHA-256, and the official `postgres:16` image at Compose's digest                                                                                |

The native server processes do gain the user's file access. Bot commands never run on the host
unless the user turns on the existing local computer access, which is unchanged.

## What breaks or is unsupported

- Intel Macs and macOS 15 or older: Docker remains the path.
- Docker-only knobs: `SANDBOX_COMPUTER_EGRESS=restricted`, the IPv6 settings, shared host folders,
  and `SANDBOX_SCREEN_NETWORK`. Shared host folders could map to `container run --volume` later.
- Computers keep no OS changes between stops (only the workspace), as on Incus and Kubernetes.
- Requested CPUs are a soft hint: one VM reported 3 CPUs when 2 were asked.
- `container`'s services use fixed `com.apple.container.*` launchd labels, so the app shares a
  running system instead of starting a second one (see runtime resolution). Our resources are
  namespaced (`rakazo-` names, the `rakazo.bot-id` label), so we never touch the person's own. The
  database VM, network and volume are `rakazo-postgres` with no bot label; the `local-vm` provider
  only removes VMs labelled for a bot, so its cleanup never touches them. One runtime holds one
  native stack's database.
- Worker jobs running at quit get a short grace (not Compose's 50 minutes) before the process is
  killed; their locks expire as after any crash.
- `SANDBOX_PROVIDER` is always `local-vm` on this path, whatever the shared `.env` says.
- No API is exposed beyond loopback, so phones on the LAN cannot reach a native stack without the
  existing remote access options.

## Not verified

- Anything inside the packaged, signed Electron app: Electron's binary as Node under the hardened
  runtime, the one-time dialog, quitting with processes running. The real runs drove the controller
  with Node itself.
- Starting our own downloaded runtime copy with only the four kept plugins (a system was already
  running on the test Mac and only one can run at a time); the download, signature check and
  expansion were run for real.
- The Docker move against Docker Desktop: verified on OrbStack only. It uses `docker compose exec`
  and `docker cp` streams, nothing specific to how Docker reaches the Mac.
- A full computer boot through the desktop controller: the published `edge` computer image has no
  `nft` yet, so `local-vm` failed closed with its error, as designed. The provider's live test did
  boot a locally built image with `nft` and passed with the firewall on. Computers start once an
  image built from this change is published.

## Decided

- Computers must not reach the Mac or the local network; the agent uses the Mac only through the
  existing, approved local computer access.
- Everything is downloaded on demand, only when **This computer** is chosen.
- A `container` system the person already runs or installed is reused; ours is downloaded only when
  there is none.
- Existing Docker users are offered the move once.
- The database is the official `postgres:16` image at the same digest as Compose, run through the
  computer runtime. It replaces the test-fixture Postgres binaries the first version downloaded.

## Later

- A small Swift helper on the Containerization framework with its own launchd label would remove
  the shared-system constraint entirely. Worth it only if sharing causes real problems.
- Kernel: keep the one `container` downloads, or build our own minimal one.
