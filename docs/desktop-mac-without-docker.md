# This computer on a Mac without Docker

Status: built in `apps/desktop` (`native-stack.ts`, `mac-runtime.ts`, `docker-move.ts`). On Apple
silicon Macs with macOS 26 or newer, release builds that name a server bundle run **This computer**
without Docker; every other platform, and any build without a server bundle, keeps the Docker path
unchanged.

## Summary

- The server side does not need containers. Postgres 16 runs as a native binary and the API,
  worker and web run as plain Node processes, all bound to `127.0.0.1` under the app's data
  directory. Verified on this Mac (below).
- Bot computers run as one lightweight Linux VM each through Apple's open-source `container`
  runtime (Apache 2.0, Virtualization.framework), from the **unchanged** published computer
  image. A new sandbox provider, `local-vm`, plugs into the existing `SandboxProvider` seam the
  way the Incus provider does: no supervisor, no Docker socket, screen reached on the VM's address.
  Verified end to end through the real API (below).
- Nothing is bundled: the app download does not grow. The database, the server bundle and (unless
  the person already runs one) the computer runtime are downloaded, pinned by size and SHA-256, only
  when **This computer** is chosen. First start measured below at under a minute plus the
  computer runtime download; later starts take about 4 seconds.
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
| Postgres 16.15 native binary (embedded-postgres build)      | `initdb` 1.7 s, start < 1 s, loopback only; all Prisma and job-queue migrations plus runtime role in 6.6 s                                                           |
| API, worker, web as Node processes                          | `/internal/health` reports `sandbox: local-vm`; Graphile worker connected; web preview served and proxied the API                                                    |
| Sign up, create bot, `computer.boot` through the web origin | Computer running 4 s after boot; `computer.screenUrl` issued a capability URL                                                                                        |
| Proxied screen                                              | Capability URL page served through the web proxy; its websocket returned the VNC `RFB 003.008` banner from the VM                                                    |
| Persistence                                                 | File written in VM 1 survived `computer.stop` (checkpoint into `DATA_DIR/homes`) and was present in a brand-new VM 2 after `computer.boot`                           |
| Memory                                                      | One running computer with Chromium: about 970 MB host RSS (2 GB cap). Native API + worker + web + Postgres together: about 245 MB                                    |

The live provider test is `VERIFY_LOCAL_VM=1 LOCAL_VM_CLI=<path to container> pnpm exec vitest run
packages/adapters/src/apple-container-sandbox.test.ts`. It is skipped by default and in CI.

Not verified: a model-driven bot run on the VM computer, the in-app screen viewer in Electron, the
terminal over the screen gateway, sleep/wake of the Mac with VMs running, Intel or macOS 15
behavior, and anything packaged or signed as part of the app.

## Server stack without Docker

| Today (Docker Compose)                 | Mac without Docker                                                                                                                         |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `postgres:16` container, named volume  | Postgres 16 binaries (downloaded), cluster in `<userData>/stack/postgres`, `listen_addresses=127.0.0.1`, random port, Unix socket disabled |
| `migrate` container (`pnpm db:deploy`) | Same migration code run by Electron-as-Node before the API starts                                                                          |
| `api`, `worker` containers             | `dist/index.js` of each, run with `ELECTRON_RUN_AS_NODE=1` from the app binary (no separate Node)                                          |
| `web` container (`vite preview`)       | The built web assets plus the existing screen/API proxy, served by a small Node process on loopback                                        |
| `sandbox-supervisor` + Docker socket   | Gone. The API and worker call the `container` CLI (theirs or downloaded) through the `local-vm` provider                                   |

### How the desktop app runs it

`main.ts` picks the controller once per launch. `NativeStackController` has the same surface as the
Docker `LocalStackController` (`webUrl`, `state`, `start`, `stop`, `abort`, `matchesDesiredStack`)
and pushes the same events, so the setup screen renders it unchanged: downloads report bytes per
component in the `pulling` phase, and milestones and migration output appear as output lines.

A start, in order:

1. Shares the Docker path's `.env` (generated secrets, the person's own settings), stack token and
   web URL file in `<userData>/stack`, and stops processes a crashed launch left behind (recorded in
   `run/*.pid` and checked against their command line; the database last).
2. In parallel: the database binaries, the server bundle (`server-bundle.json` in the app's
   resources; `RAKAZO_SERVER_BUNDLE=<local .tar.xz>` in unpackaged builds) and the computer runtime
   (below). Each download streams to a temporary file, is checked for size and SHA-256, and only
   then unpacked into a scratch folder that is renamed to `runtime/<name>-<version>`.
3. Creates the cluster once (`initdb` with scram-sha-256 and ICU `en-US`, then `CREATE DATABASE` in
   single-user mode, in a scratch folder renamed into place), starts it on a loopback port with the
   Unix socket disabled, and waits for it to report ready.
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

Ports are saved in `.native-ports` (database, API) and `.desktop-web-url` (web) and reused while
free, so the web origin and its sign-in survive relaunches; a taken port is replaced and saved.
A process that crashes after the stack is ready restarts with backoff (1 s doubling to 30 s,
reset after a minute up); a crash during start fails the start with that process's last log lines.
Output goes to `logs/<name>.log` (the previous launch's in `<name>.previous.log`). Quitting the app
stops everything: SIGTERM, then the database with SIGINT (fast shutdown), SIGKILL after a grace.

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
starts theirs; a copy of ours older than 1.7.0 is stopped and replaced the same way. A system the
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

| Component                                       | Download | On disk | Source                                                            |
| ----------------------------------------------- | -------- | ------- | ----------------------------------------------------------------- |
| Server bundle (API, worker, web, migrations)    | 117 MB   | ~900 MB | This release's GitHub asset, pinned by `server-bundle.json`       |
| Postgres 16.15 binaries                         | 62 MB    | ~110 MB | Maven Central (`io.zonky.test` embedded binaries), pinned in code |
| Computer runtime 1.7.1 (only when none is used) | 170 MB   | 182 MB  | Apple's signed release package, pinned in code                    |
| Linux kernel for the VMs                        | ~30 MB   | ~30 MB  | Fetched by the runtime itself on its first start                  |
| Computer image                                  | —        | 1.58 GB | Pulled in the background once the stack is ready                  |

## First run

Measured on this Mac (fast connection) with the real downloads and a locally built bundle, against a
computer runtime that was already running:

| Run                                                             | Time to ready           |
| --------------------------------------------------------------- | ----------------------- |
| First start (database download, bundle unpack, migrations)      | 55 s                    |
| Later start                                                     | 4 s                     |
| Later start after a crashed launch left processes behind        | 4.5 s                   |
| Move from a Docker stack (dump, restore, file copy, migrations) | 9 s (small sample data) |
| Computer runtime package: download, verify, expand              | 47 s                    |

A first start that also downloads the runtime adds its 47 s in parallel with the other downloads,
plus the kernel download on its first start (about 45 s measured). The computer image pull
(about 50 s) runs in the background after the app is ready.

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
- Docker users: when a Docker stack exists (its compose file is in the stack folder), no native
  database exists yet, the saved setup is **This computer** and Docker answers, the app asks once
  ("Run Rakazo without Docker?" with **Move** and **Keep Docker**) and remembers the answer in
  `.desktop-stack-choice`. **Keep Docker** keeps today's path. **Move** keeps the same `.env`
  (so `BETTER_AUTH_SECRET`, `ENCRYPTION_KEY` and the other secrets carry over) and, on the next
  start, after the new database is up and before migrations: stops the Docker API, worker, web
  and supervisor, creates the `rakazo_app` role in the new database, then inside the Docker
  database container pipes `pg_dump --format=custom` into `pg_restore --no-owner --exit-on-error`
  against the native database at `host.docker.internal` (credentials in the environment, never on
  a command line), copies `/data` out of the stopped API container with `docker cp`, and stops the
  whole Docker stack without removing it or its volumes. Only then is the move marked done
  (`postgres/.docker-imported`). If any step fails the Docker services it stopped are started
  again, the new database is removed, the Docker data is untouched and **Retry** runs the move again; a move cut short by a quit or crash has no marker, so
  the next start discards the partial database and copied files and runs it again.
- Computers re-provision from saved homes because the provider kind changes, which the lifecycle
  already handles.
- Rollback to Docker: the Docker stack and its volumes are left in place; nothing moves back
  automatically.

## Security and isolation compared with today

| Concern               | Docker Desktop today                                                      | Native stack + `local-vm`                                                                                |
| --------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Computer vs. computer | Containers sharing one Linux VM and kernel; per-bot Docker networks       | One VM and kernel per computer; per-computer network, verified unreachable from each other               |
| Computer vs. host     | Docker Desktop VM; host services reachable through `host.docker.internal` | Refused by the in-VM firewall, except DNS on the gateway (verified)                                      |
| Egress restriction    | Unsupported on Docker Desktop (`open`)                                    | Always on: public internet only, enforced inside each VM; a bot that gained root in its VM could lift it |
| Privileged component  | Supervisor holds the Docker socket, root-equivalent on the Docker VM      | No socket. The API and worker can create VMs as the signed-in user, nothing more                         |
| Server processes      | Inside the Docker VM                                                      | Run as the user on the host, bound to loopback. They are our code; bot commands still only run in VMs    |
| Third-party code      | Docker Desktop (user-installed)                                           | Apple's signed `container` and zonky's Postgres 16 build, downloaded on demand and pinned by SHA-256     |

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
  namespaced (`rakazo-` names, the `rakazo.bot-id` label), so we never touch the person's own.
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
- The Docker move against Docker Desktop: verified on OrbStack, where `host.docker.internal` reaches
  a listener bound to the Mac's `127.0.0.1`. Docker Desktop documents the same forwarding but was
  not tried.
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

## Later

- A small Swift helper on the Containerization framework with its own launchd label would remove
  the shared-system constraint entirely. Worth it only if sharing causes real problems.
- Kernel: keep the one `container` downloads, or build our own minimal one.
