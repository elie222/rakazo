# Docker computers

Limit what each local Docker computer can use, keep it off your network, share host folders
with it, and optionally give its programs or its browser a GPU.

The Docker supervisor is not published as its own image and is not exposed on the host. It runs from
the app image, stays on the internal Compose network, and holds the Docker socket because access to
it is equivalent to control of the Docker host. Docker sandboxes require `SANDBOX_SUPERVISOR_TOKEN`
(API, worker, supervisor). `SCREEN_PROXY_SECRET` signs browser-screen capabilities (API and web
proxy). Keep both distinct from `BETTER_AUTH_SECRET`.

## Resource ceilings

Each Docker computer runs Xvfb, a window manager and a full Chromium driven by an agent that
decides for itself what to open, so it is capped. These defaults provide a starting point for the
Docker computer topology:

| Variable                     | Default | Accepts                                                                                              |
| ---------------------------- | ------- | ---------------------------------------------------------------------------------------------------- |
| `RAKAZO_COMPUTER_MEMORY`     | `2g`    | `2g`, `1536m`, a byte count. Minimum `6m`, Docker's own floor. Also caps swap, so the ceiling holds. |
| `RAKAZO_COMPUTER_CPUS`       | `2`     | Whole or fractional cores, e.g. `1.5`                                                                |
| `RAKAZO_COMPUTER_PIDS_LIMIT` | `2048`  | A positive integer                                                                                   |

Set any of them to `0`, `none` or `unlimited` to remove that ceiling. A malformed value fails the
supervisor at startup naming the variable, rather than surfacing later as a failed bot.

When a computer is close to its PID or memory ceiling and a command in it fails, the supervisor's
log points to the ceiling as the likely cause: `computer.pids_near_limit` or
`computer.memory_near_limit`, with the computer's container ID and the current and maximum values,
at most once a minute per computer. If it keeps appearing, raise that ceiling or run fewer bots on
the host.

Two caps bound how many computers exist. `SANDBOX_MAX_COMPUTERS_PER_USER` caps the computers one
user's bots may have, and `SANDBOX_MAX_COMPUTERS_PER_SPACE` caps concurrent computer containers per
Space. `SANDBOX_TEAM_SCREEN_LIMIT` caps active bot desktops on one Team Computer; desktops and
browsers otherwise start only when needed. `0`, the default, leaves each to the machine.

The supervisor reaches Docker at `/var/run/docker.sock` (or `//./pipe/docker_engine` on Windows). Set
`DOCKER_SOCKET` for rootless Docker, Colima or another path; `DOCKER_HOST` wins when both are set.

## Restricted computer egress

On a cloud VM, explicitly choose `SANDBOX_COMPUTER_EGRESS=restricted` after installing
the host rules. This refuses to start computers if enforcement is missing. The default
`auto` preserves compatibility on hosts without those rules and can allow access to
cloud metadata and internal networks. Restricted egress also blocks intentional access
to local models, private repositories and other LAN services. Choose `open` only when
that network access is intended and the host is appropriately isolated.

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

To see the supervisor's current egress decision, run this from the Compose install directory:

```bash
docker compose -f docker-compose.images.yml exec supervisor pnpm --filter @rakazo/sandbox-supervisor egress
```

Use the same Compose files and project options you used to start the stack. The report shows
whether the firewall check is pending, verified, or failed, and explains when `auto` fell back to
open egress. It reports the supervisor's last check for new computer starts. Recreate the
supervisor after changing the host rules to run that check again.

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

## IPv6 for computers

Computer networks are created with IPv6 in open egress mode (Docker Engine 27+): Docker
allocates a private ULA /64 per network and masquerades outbound traffic through the host's
IPv6 address, so computers reach IPv6-only sites, while names with both address families
stay on IPv4 (RFC 6724 address selection with a ULA source). Restricted egress stays
IPv4-only: the host ruleset and the startup check enforce and verify IPv4 only. An existing
computer picks IPv6 up when its network is created again: a stop releases the network, and
the next start creates a new one. Docker 26, Docker-in-Docker without `ip6_tables` and
hosts with IPv6 disabled fall back to IPv4-only networks; the supervisor logs a warning and
computers start unchanged. A computer can also stay on IPv4 for longer when its IPv4-only
network could not be removed (another user keeps it); IPv4 keeps working, and IPv6 returns
once that network is gone — for example after `docker network rm` of the computer's
`rakazo-computer-*` network while it is stopped.

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

## GPUs for programs

`SANDBOX_COMPUTER_COMPUTE_GPUS` lets programs inside every bot computer compute on the host's
GPUs (Docker sandboxes only): `all`, or a count such as `1`, with the same meaning as
`docker run --gpus`. A bot can then run GPU software in its own computer, such as speech
recognition, image generation or model training. Leave it unset and Docker hands computers no
GPUs for compute. A render node passed in for the browser (see GPU for the browser) is still open
to programs in the computer.

The Docker host needs a GPU driver that Docker can hand to containers, which for most GPUs
means installing the vendor's container toolkit and checking that
`docker run --rm --gpus all <image> <the vendor's status tool>` works. The supervisor asks Docker
for GPUs without naming a driver, so any driver Docker offers for `--gpus` is used. The computer
image ships no compute libraries, only Mesa's graphics drivers for the browser: the driver adds
its own at start, and a bot installs the frameworks it needs in its home. When the host cannot
provide the GPUs, Docker refuses to create the computer and the bot's computer fails to start
until the setting or the host is fixed.

Changing the setting replaces each computer the next time it starts; the home is kept. It does
not change the browser, which keeps rendering pages in software unless it gets a render node
(see GPU for the browser).

WARNING: the setting is deployment-wide, and a GPU is shared hardware. Every bot in every Space
reaches the host's GPU driver directly, which is a larger attack surface than the rest of the
sandbox, and nothing limits how much GPU memory or time one computer takes from the others or
from other GPU software on the host. Enable it only when you trust every bot on the deployment
with that.

## Browser proxy

Some public sites refuse connections from datacenter addresses. With
`SANDBOX_COMPUTER_BROWSER_PROXY_PAC_URL` the bot browser sends selected sites through an HTTP
proxy you run, and every other site connects directly as before (Docker sandboxes only). The
value is a [proxy auto-config](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Proxy_servers_and_tunneling/Proxy_Auto-Configuration_PAC_file)
(PAC) script: an absolute `http://` or `https://` URL the browser downloads it from, or the whole
script as a base64 `data:` URL of at most 64 KiB, for example:

```sh
pac='function FindProxyForURL(url, host) {
  if (dnsDomainIs(host, ".example.com")) return "PROXY proxy.example.net:3128";
  return "DIRECT";
}'
echo "SANDBOX_COMPUTER_BROWSER_PROXY_PAC_URL=data:application/x-ns-proxy-autoconfig;base64,$(printf '%s' "$pac" | base64 | tr -d '\n')"
```

The supervisor refuses to start with any other kind of value, or one containing spaces. It hands
the value to every computer, whose browser starts with `--proxy-pac-url`; page reading and the
bot's browser actions use that same browser, so they follow the script too. Programs the bot
runs in its terminal do not. Unset, nothing changes.

Under restricted egress the computer reaches only public addresses, so the PAC URL and the
proxy must be on public addresses as well; a proxy on the Docker host or the LAN is blocked.
Recreate the supervisor after a change; each computer picks it up on its next start, which
replaces it. The home and saved browser profiles are kept.

## Time zone and language

Each computer runs in its owner's time zone and app language when the account has them: the
supervisor sets `TZ` and `LANGUAGE` on the container, and the browser offers pages that language
(`Accept-Language` and `navigator.languages`), also for a browser profile saved earlier. Without
them, the computer stays on UTC and the browser's default language. A changed time zone or
language replaces the computer on its next start, so after upgrading, each computer whose owner
has either set is replaced once. The home and saved browser profiles are kept. A custom computer
image should not set `TZ` or `LANGUAGE`: the computer gets them from the account.

## GPU for the browser

Computers render pages in software by default. To let the bot's browser use a host GPU, pass one
render node with `SANDBOX_COMPUTER_GPU` (Docker sandboxes only):

```env
SANDBOX_COMPUTER_GPU=/dev/dri/renderD128
```

The supervisor must see the host's `/dev/dri`. When it runs in Compose, give the supervisor
service a read-only bind in a Compose override file:

```yaml
services:
  supervisor:
    volumes:
      - /dev/dri:/dev/dri:ro
```

The bind only lets the supervisor read the nodes' type, number and group. It cannot open them because it gets no `--device`: Docker's device policy refuses the open (`Operation not permitted`), not the read-only bind.
Only DRM render nodes are accepted, never `card*`: the node must be character device 226 with a
minor of 128 or more, and not a symlink (Docker follows a symlink to whatever device it names).
Each computer joins the node's own group, so the node must not be owned by the root group (give
it a group such as `render`). The supervisor refuses to start when the node is missing, not
visible, another device, or owned by group 0, and checks it again before it creates or starts each
computer.

WARNING: the render node enlarges the sandbox's kernel attack surface. Page code (WebGL, WebGPU,
shaders) then reaches the host's GPU driver and Mesa through the node, and the browser runs
without its own sandbox. A driver bug can let a page escape the computer or hang the host GPU for
every other user of it. Turn it on only with a GPU you can dedicate to bot computers and a current
kernel.

Each computer gets the node at the same path; nothing else from `/dev` is passed in, and the
other confinement is unchanged. The browser renders through ANGLE on Vulkan when it can open the
node and the image's Mesa Vulkan drivers list the GPU (`vulkaninfo --summary` in the computer).
Otherwise it keeps software rendering. The drivers come from the image's Debian release, so Intel
and AMD GPUs that this Mesa supports work; GPUs newer than it, and NVIDIA GPUs, which need
NVIDIA's own driver and container toolkit, stay in software. Recreate the supervisor after a
change; each computer picks up the new setting on its next provision, which replaces it.
