# Docker computers

Limit what each local Docker computer can use, keep it off your network, and share host folders
with it.

The Docker supervisor is not published as its own image and is not exposed on the host. It runs from
the app image, stays on the internal Compose network, and holds the Docker socket because access to
it is equivalent to control of the Docker host. Docker sandboxes require `SANDBOX_SUPERVISOR_TOKEN`
(API, worker, supervisor). `SCREEN_PROXY_SECRET` signs browser-screen capabilities (API and web
proxy). Keep both distinct from `BETTER_AUTH_SECRET`.

## Resource ceilings

Each Docker computer runs Xvfb, a window manager and a full Chromium driven by an agent that
decides for itself what to open, so it is capped. These defaults provide a starting point for the
Docker computer topology:

| Variable | Default | Accepts |
| --- | --- | --- |
| `RAKAZO_COMPUTER_MEMORY` | `2g` | `2g`, `1536m`, a byte count. Minimum `6m`, Docker's own floor. Also caps swap, so the ceiling holds. |
| `RAKAZO_COMPUTER_CPUS` | `2` | Whole or fractional cores, e.g. `1.5` |
| `RAKAZO_COMPUTER_PIDS_LIMIT` | `2048` | A positive integer |

Set any of them to `0`, `none` or `unlimited` to remove that ceiling. A malformed value fails the
supervisor at startup naming the variable, rather than surfacing later as a failed bot.

Two caps bound how many computers exist. `SANDBOX_MAX_COMPUTERS_PER_USER` caps the computers one
user's bots may have, and `SANDBOX_MAX_COMPUTERS_PER_SPACE` caps concurrent computer containers per
Space. `SANDBOX_TEAM_SCREEN_LIMIT` caps active bot desktops on one Team Computer; desktops and
browsers otherwise start only when needed. `0`, the default, leaves each to the machine.

The supervisor reaches Docker at `/var/run/docker.sock` (or `//./pipe/docker_engine` on Windows). Set
`DOCKER_SOCKET` for rootless Docker, Colima or another path; `DOCKER_HOST` wins when both are set.

## Restricted computer egress

Restricted egress gives Docker computers the public internet (browsing, DNS, apt, git
over SSH) but not the Docker host, the LAN, or link-local cloud metadata such as
`169.254.169.254`, which on a cloud VM would hand instance credentials to anything a bot runs.

It takes two parts:

1. `SANDBOX_COMPUTER_EGRESS=restricted` gives each computer network a deterministic host
   bridge name (`rakazo-c…`) instead of a generic `br-*`.
2. The host ruleset, applied once per Docker host:

   ```bash
   sudo bash infra/compose/restrict-computer-egress.sh
   ```

   `install-images.sh` downloads and runs it (asking for sudo) and records the result in
   `.env`. Where the rules cannot be installed (macOS, Windows, Docker Desktop, rootless
   Docker, no iptables, or a failed run) it writes `SANDBOX_COMPUTER_EGRESS=open` and says
   why. The script drops forwarded traffic from `rakazo-c*` bridges to all non-public IPv4/IPv6
   destinations via the `DOCKER-USER` chain, adds an `INPUT` drop so computers cannot open
   connections to the host (established replies to host-initiated control and screen
   connections still flow), and installs a systemd oneshot so the rules return after a
   reboot. `--print` shows the exact rules without changing anything; `--remove` uninstalls.

Before the first restricted computer starts, the supervisor checks that the host drops
connections from a `rakazo-c*` bridge. Without the ruleset, computers fail to start with an
error naming the script instead of running unrestricted; run the script (no restart needed)
or set `SANDBOX_COMPUTER_EGRESS=open` and recreate the supervisor.

When `SANDBOX_COMPUTER_EGRESS` is unset, the Compose files use `auto`: the supervisor runs the
same check and uses restricted egress if the ruleset is in place, otherwise open egress with a
warning in its log. It keeps the first completed answer; a check that could not finish (a Docker
error or timeout) fails that computer's start and runs again on the next one. With the ruleset
in place, so does a configured `SANDBOX_COMPUTER_DNS` that no server answers (see below). An
install from before the ruleset existed therefore keeps working when it upgrades. After
installing the ruleset, recreate the supervisor, or set `restricted` to refuse computers
whenever the rules are missing. A host-run supervisor (`pnpm dev`) and the desktop app's
**This computer** stack default to open: Docker Desktop keeps its bridges in a VM the host
rules cannot reach.

Screen streaming is unaffected: the supervisor and web proxy join each computer's bridge,
and the ruleset exempts traffic whose in- and out-interface are both `rakazo-c*` before
any drop (that exemption is load-bearing on hosts where `br_netfilter` feeds bridged
frames through `FORWARD`). Rules match interface names rather than subnets, so computer
create/delete cycles need no firewall maintenance; deleting a computer removes its
traffic from the match and nothing else. A computer provisioned while egress was open
is replaced on its next provision — resuming it on an unnamed bridge would bypass the
restriction.

Computers resolve names through Docker's embedded DNS. Docker 28 and newer forward lookups
to the host's own resolvers from the host's network, so a private host resolver (a cloud VPC
resolver, a LAN router) keeps working. Older Docker versions forward from the computer's
network, and so does any server set in `SANDBOX_COMPUTER_DNS` or the daemon's `dns` option;
the ruleset drops those lookups when the resolver has a private address, and every lookup
times out while connections by IP still work. In those cases set `SANDBOX_COMPUTER_DNS` to
public resolvers (comma-separated IP addresses, such as `1.1.1.1,1.0.0.1`) and recreate the
supervisor; each computer picks the servers up on its next provision. When
`SANDBOX_COMPUTER_DNS` is set, computers with restricted or `auto` egress start only after one
of its first three servers (Docker uses no more) answers from a computer network; a start that
fails this check retries it on the next start. The check runs from an IPv4-only network and
skips IPv6 servers, so if those three are all IPv6 nothing is checked.

### Opening egress

If computers must reach LAN services, an internal proxy, or endpoints bound to the host,
set `SANDBOX_COMPUTER_EGRESS=open`, recreate the supervisor, and run
`sudo bash infra/compose/restrict-computer-egress.sh --remove`. The flag alone does not
uninstall the host rules, which keep matching the still-named `rakazo-c*` bridges until
removed.

The ruleset requires Linux Docker Engine with the iptables backend; Docker Desktop, rootless
Docker, and `firewall-backend: nftables` are unsupported. The
`SANDBOX_SCREEN_NETWORK=internal` topology shares one network instead of per-bot bridges,
so the mode does not apply there.

### Docker in a Linux VM

Where Docker Engine runs in a Linux VM, as with OrbStack on macOS, the rules belong in the VM,
which `sudo` on the host cannot reach. Apply them from a container on the VM's host network
instead, and keep it running: the VM does not persist the rules, so a loop puts them back after
a restart. The installer does not download the script on macOS. From the directory that holds
the stack's `.env`:

```bash
curl -fsSLO https://raw.githubusercontent.com/elie222/rakazo/main/infra/compose/restrict-computer-egress.sh
```

Save the following as `egress.yml` beside that script and start it with
`docker compose -f egress.yml up -d`. The name keeps it in its own Compose project:

```yaml
name: rakazo-computer-egress
services:
  computer-egress:
    image: alpine:3
    network_mode: host
    cap_add: [NET_ADMIN, NET_RAW]
    restart: unless-stopped
    volumes:
      - ./restrict-computer-egress.sh:/restrict-computer-egress.sh:ro
    command: >-
      sh -c "apk add --no-cache bash iptables ip6tables &&
      while true; do bash /restrict-computer-egress.sh --apply; sleep 60; done"
```

Then change `SANDBOX_COMPUTER_EGRESS` from `open` to `restricted` in `.env` and recreate the
supervisor. Docker Desktop has not been tested this way.

## Shared host folders

`SANDBOX_COMPUTER_MOUNTS` mounts host directories into every bot computer (Docker sandboxes
only): comma-separated `source:target[:option...]` entries, for example
`/srv/team-docs:/mnt/team-docs`. Mounts are read-only unless the entry adds `rw`; `rslave` is the
other option and requires `rw`, because mounts that reach the computer later keep their own
write access. Both paths must be absolute without `..`, and targets must sit below `/mnt`,
`/media` or `/srv`. On Docker Desktop for Windows, write a source in its WSL form
(`/mnt/c/Users/me/Docs` for `C:\Users\me\Docs`); Docker rejects the Windows form, and `rslave`
does not work on these folders.

The setting is deployment-wide: every bot in every Space sees every mount, and with `rw` any of
them can change or delete what another Space's bots read. Mount only what all of them may see.
The supervisor rejects a source that is, holds, or sits inside the Docker socket,
`/run`, `/var/run`, `/proc`, `/sys`, `/dev`, `/etc`, `/boot`, `/root`, `/var/lib/docker` or
the data directory that holds bot homes. It compares the configured path, and Docker follows
host symlinks, so never point a source at one of these through a symlink.

When the source holds a mount that can be replaced while computers run,
such as an SSHFS or NFS share that reconnects, mount the share one level below the source
(`/srv/shares/docs`, with `source` `/srv/shares`) and add `rw:rslave`, so the new mount reaches
running computers instead of leaving them on the dead one. Mounting the share at the source
itself does not work: replacing it leaves running computers on the old one.

`rslave` also needs the source to sit on a shared or slave host mount. Check with
`findmnt -no PROPAGATION -T <source>`; systemd hosts report `shared` for most paths. If it reports
`private`, Docker refuses to create the computer, so make the source its own shared mount first
(`sudo mount --rbind <source> <source>` then `sudo mount --make-rshared <source>`; `--rbind`
keeps a share already mounted below the source visible. Repeat it at boot, before the share
mounts, for example from a systemd mount unit the share's unit depends on). The source must
exist on the Docker host. Recreate the supervisor after a change; each computer picks the new
set up on its next provision, which replaces it.
