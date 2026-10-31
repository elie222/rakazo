# Self-host sandbox / computer providers

`SANDBOX_PROVIDER` selects where bot computers run. Workspace bots share a Team Computer by
default; Private Computers are optional. See [computer runtime and isolation](./computer-runtime.md)
for the sharing and persistence contract.

## Quick pick

| Goal | Set | Also need |
| --- | --- | --- |
| Local Docker computers | `SANDBOX_PROVIDER=docker` | `SANDBOX_SUPERVISOR_TOKEN`, computer image, Docker socket for supervisor |
| UI only, no computers | `SANDBOX_PROVIDER=none` | No provider credential; published-images Compose still requires `SANDBOX_SUPERVISOR_TOKEN` |
| Managed remote desktop | `e2b` / `novita` / `daytona` / `boat` / `boxd` | `SANDBOX_SUPERVISOR_TOKEN` (published-images Compose), matching API key (and optional URL knobs for Daytona/Boat) |
| One pod per computer on your own cluster | `SANDBOX_PROVIDER=kubernetes` | API and worker running in the cluster, a namespace and a Role that can create, read, delete and exec into pods |

Published-images [Compose](../infra/compose/docker-compose.images.yml) defaults to **`docker`**.
It always starts the supervisor and requires `SANDBOX_SUPERVISOR_TOKEN`, including for `none`
and remote providers. This stack credential does not replace a remote provider's API key.

## Choosing a provider

The Electron desktop app is a client of the same API. Docker remains the default. For an app-managed local instance, the local operator can choose **Use this Mac** (macOS) or **Use this computer** (Windows/Linux). After native confirmation, an authenticated bridge sends commands from the Docker backend to Electron, where they run under your OS account. **Computer Access…** in the app menu changes the choice; **Revoke Local Computer Access** immediately disconnects active operations and revokes the saved permission. Local execution requires the desktop app to remain running. Connecting to an existing remote instance does not grant it access to your computer. Browser and mobile clients use the deployment’s configured computer; they do not expose their own host. `SANDBOX_PROVIDER=desktop` is a separate, development-only configuration for backends running directly on the intended host.

Native file reads and workspace exports are limited to 8 MiB per file. A larger workspace file fails the checkpoint and preserves the previous saved workspace; local files remain on the computer. Writes are bounded by the 12 MiB encoded request limit.

- **Published images** (`docker-compose.images.yml`) default to `SANDBOX_PROVIDER=docker` with a
  local supervisor and published `ghcr.io/elie222/rakazo/computer` image. No E2B account required.
  Optional: set `e2b`, `novita`, `daytona`, `createos`, or `boat` plus the matching API key for remote computers.
- **Docker** is the quick-start default for published images and for a source checkout / full local
  Compose stack. Workspace bots share a persistent Team Computer by default; Private computers are
  optional. Keep the supervisor private, as the included Compose files do.
- **E2B** runs bot computers away from the Rakazo host and is a good choice for public or multi-user
  production deployments. Rakazo checkpoints the portable workspace and browser-profile directory to
  `DATA_DIR`; the E2B disk is a runtime cache, not the durable source of truth.
- **Daytona** provides the same remote-computer contract through Daytona sandboxes. Configure
  `DAYTONA_API_KEY` and optionally `DAYTONA_API_URL` / `DAYTONA_TARGET` / `DAYTONA_SNAPSHOT`.
- **CreateOS** provides the same remote-computer contract through CreateOS desktop sandboxes.
  Configure `CREATEOS_SANDBOX_API_KEY` and optionally `CREATEOS_SANDBOX_BASE_URL`,
  `CREATEOS_SANDBOX_SHAPE`, or `CREATEOS_SANDBOX_ROOTFS`. Rakazo defaults to
  `https://api.sb.createos.sh`, `s-2vcpu-2gb`, and `desktop:1`.
- **Boat** provides a managed Linux desktop through `BOAT_API_KEY` and optionally
  `BOAT_API_URL`. Rakazo always creates or resumes sandboxes with `noEnv: true`, keeps the portable
  workspace under `/home/user/rakazo-home`, and refreshes a two-hour TTL. Boat uses the shared Linux
  desktop runtime and protected port routes for concurrent bot desktops. Each bot has its own
  persistent Chrome profile; logins are not shared between bots.
- **Local computer access** in the app-managed Electron instance runs commands on Windows, macOS,
  or Linux through the native bridge. Bots can read/change local files and launch installed apps
  through OS commands, subject to your account and OS permissions. Portable file tools and
  checkpoints remain scoped to bot workspaces; use commands for other local folders. Graphical
  screen control is unavailable. Permission is remembered locally and can be revoked from the
  app menu. Only enable this for a trusted personal instance: every bot on that instance can use
  your account’s permissions.
- **Desktop provider** (`SANDBOX_PROVIDER=desktop`) runs commands directly on the API/worker host,
  with only a minimal shell environment (no server secrets). The API and worker refuse it unless
  `NODE_ENV` is `development` or `test`, so a production server never runs bot commands on itself.
  Setting this inside a container does not grant access to the physical computer. Docker deployments
  use the authenticated native bridge when local computer access is selected; they never silently
  fall back to executing on the backend host.
- **Fake** is only an emulator for verification.
- **None** boots the product without a computer host (fallback when Docker/supervisor is not
  configured, or when a remote provider is selected without its API key).

## `docker` (in-stack supervisor)

Compose starts a **sandbox supervisor** (from the app image) on the internal
network (port `7091` in published-images). It creates sibling **computer**
containers from `RAKAZO_COMPUTER_IMAGE` + `RAKAZO_COMPUTER_IMAGE_TAG`.

Requirements:

- Non-empty `SANDBOX_SUPERVISOR_TOKEN` (distinct from auth / screen / encryption secrets)
- Reachable computer image (GHCR default or your mirror; on arm64 pin multi-arch tags for both app and computer)
- Docker Engine available to the supervisor (socket mount on the Compose path)

Verify:

```bash
curl -fsS http://127.0.0.1:3100/internal/health
# expect sandbox: docker
```

Missing supervisor token is a **setup failure**: do not treat `sandbox: "none"` as success for this path.

Signup and local Docker computers work **without** an E2B (or other remote) account.

Resource ceilings, network isolation and shared folders for these computers are covered in
[Docker computers](./self-host-docker-computers.md).

### Bot browser

The published computer image uses Chromium. To use Brave instead, build the image with
`BROWSER=brave` and point Compose at it:

```bash
docker build --build-arg BROWSER=brave -t rakazo-computer-brave infra/sandboxes/computer
```

```env
RAKAZO_COMPUTER_IMAGE=rakazo-computer-brave
RAKAZO_COMPUTER_IMAGE_TAG=latest
```

The image holds one browser, and `rakazo-browser` launches whichever is installed. A locally built
image is not on a registry, so start the stack with `bash install-images.sh --pull-never` after
pulling the other images once. Brave's Rewards, Wallet, Leo, VPN and News are disabled by managed
policy. Browser identity is only one input to bot-check challenges; the host's IP reputation usually
matters more.

## `kubernetes`

Each computer is one pod in a namespace you choose, created from the published computer image.
The API and worker talk to the Kubernetes API with their own service account (or the kubeconfig in
`KUBECONFIG`), so they normally run in the same cluster. No supervisor or Docker socket is involved.

| Variable | Default | Notes |
| --- | --- | --- |
| `KUBERNETES_SANDBOX_NAMESPACE` | `rakazo-sandboxes` | Namespace for computer pods; it must exist |
| `KUBERNETES_SANDBOX_COMPUTER_IMAGE` | `ghcr.io/elie222/rakazo/computer:edge` | Pin a digest in production |
| `KUBERNETES_SANDBOX_RUNTIME_CLASS_NAME` | unset | For example `kata` or `gvisor` for a VM or user-space kernel boundary |
| `KUBERNETES_SANDBOX_CPU_LIMIT` / `_MEMORY_LIMIT` | unset | Container limits, such as `2` and `4Gi` |
| `KUBERNETES_SANDBOX_POD_LABELS` / `_POD_ANNOTATIONS` | unset | JSON objects of strings, merged into every pod |
| `KUBERNETES_SANDBOX_READY_TIMEOUT_MS` | `120000` | How long a new pod has to become ready |

Each pod runs the image's own user (uid 1000) with no service account token and no service links,
with all Linux capabilities dropped, privilege escalation off and the runtime's default seccomp
profile, like a Docker computer (these apply to newly created pods; a pod that was already running
keeps its old spec until it is stopped and recreated),
and is labelled `app.kubernetes.io/name=rakazo-computer` and `rakazo-bot-id=<bot id>`. Commands,
file transfers and workspace save and restore go through `pods/exec`; save and restore stream the
home as one tar archive. Screens use the image's desktop gateway on the pod IP, so the API, the
worker and the web screen proxy must be able to reach pods in that namespace on port `6080` and the
display ports from `6100` upward. Pods are ephemeral: the
saved workspace is the persistence boundary, as with the remote providers. Kubernetes computers do
not bill while running, so `COMPUTER_MAX_ACTIVE_MS` does not apply to them.

### Mounted home (optional)

By default each computer's home is copied in when it starts and saved back when it stops. Set
`KUBERNETES_SANDBOX_HOME_CLAIM` to the PersistentVolumeClaim that holds the API's `DATA_DIR` to
mount `homes/<home key>` from it at the workspace instead, so the home is never copied, like a
local Docker computer. The claim must be in the computer namespace, so in practice the computers
run in the API's namespace. Because a ReadWriteOnce volume is attached to one node,
`KUBERNETES_SANDBOX_HOME_COLOCATE_NAMESPACE` and `KUBERNETES_SANDBOX_HOME_COLOCATE_LABELS` (a JSON
object) are required with it and become a required pod affinity to the pods that hold the volume,
for example `{"app":"rakazo-api"}`. The pod gets `fsGroup: 1000`. An existing pod without the home
volume keeps copying its files until it is stopped; its next fresh pod mounts the saved home. This applies only to the local home store; with
`OBJECT_STORAGE_BUCKET` set, the home claim is ignored and homes are copied as usual.

The API and worker service account needs this in the computer namespace:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: rakazo-computers
  namespace: rakazo-sandboxes
rules:
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["create", "get", "delete"]
  - apiGroups: [""]
    resources: ["pods/exec"]
    verbs: ["create", "get"]
```

Bind it to the service account the API and worker run as with a `RoleBinding`. A NetworkPolicy
that admits only the API, worker and web pods to the computer pods, and denies their egress to
private ranges, is recommended.

## `wuying`

Bot computers run on one existing Wuying (无影) cloud computer. Each computer's home is a folder
under the desktop user's profile (`%USERPROFILE%\rakazo\<home>`), and the desktop's own disk
keeps it between stops, so nothing is copied in or out. Commands run in PowerShell; files,
screenshots and input go through the desktop's MCP gateway. Stopping the computer powers the
desktop off; deleting it removes only its home folder, never the desktop.

| Variable | Notes |
| --- | --- |
| `WUYING_ACCESS_KEY_ID` / `WUYING_ACCESS_KEY_SECRET` | RAM user allowed `ecd:DescribeDesktops`, `ecd:StartDesktops`, `ecd:StopDesktops` and `appstream-center:GetAuthCode`. API and worker only |
| `WUYING_REGION_ID` | Defaults to `cn-hangzhou` |
| `WUYING_DESKTOP_ID` | The cloud computer, assigned to the end user below |
| `WUYING_END_USER_ID` | Screen logins are issued for this user |
| `WUYING_MCP_URL` / `WUYING_MCP_TOKEN` | The desktop's MCP gateway and its bearer token |

The web and Electron screen is drawn by the Wuying Web SDK in `/wuying/screen.html`, served by
the web app. Mobile rejects the custom screen URL and does not embed this SDK. The
SDK is not committed; fetch the pinned release before building the web app:

```bash
node scripts/wuying-web-sdk.mjs
```

The SDK runs in an opaque-origin sandboxed frame with an in-memory storage shim and a no-op
cookie accessor in both its launcher and nested runtime. A CSP scoped to `/wuying/` permits
the vendor hosts, blob workers and WebAssembly compilation. The one-time login code stays
only in the URL fragment, outside HTTP requests and Referer.

All bots, users and spaces configured with this provider, including Private Computers, share
the same Windows desktop and account permissions, including files outside their workspace
folders. Use it only in a trusted deployment.
The gateway bounds each call to one minute, 16 KiB of command output and 1,000 folder entries.
A command allowed longer than a minute runs detached with its output in files under
`%USERPROFILE%\rakazo\.runs`, read back every second and removed when it ends or is cancelled.

## `none`

Runs API/web without provisioning bot computers.

## Remote providers

Set `SANDBOX_PROVIDER` to exactly one of:

| Value | Credential | Notes |
| --- | --- | --- |
| `e2b` | `E2B_API_KEY` | Hosted sandboxes |
| `novita` | `NOVITA_API_KEY` | Build the desktop template first; optional `SANDBOX_TEMPLATE` |
| `daytona` | `DAYTONA_API_KEY` | Optional `DAYTONA_API_URL`, `DAYTONA_TARGET`, `DAYTONA_SNAPSHOT` |
| `boat` | `BOAT_API_KEY` | Optional `BOAT_API_URL` (see `.env.example`) |
| `boxd` | `BOXD_API_KEY` | Optional `BOXD_ORG` to create computers in a boxd organization |
| `createos` | `CREATEOS_SANDBOX_API_KEY` | Optional `CREATEOS_SANDBOX_BASE_URL`, `CREATEOS_SANDBOX_SHAPE`, `CREATEOS_SANDBOX_ROOTFS` |
| `railway` | `RAILWAY_API_TOKEN` and `RAILWAY_ENVIRONMENT_ID` | Optional `RAILWAY_SANDBOX_REGION`; `RAILWAY_MAX_WORKSPACE_FILE_BYTES` (default 64 MiB) caps each workspace file Rakazo reads or saves. Railway supplies the environment ID when Rakazo runs there; see the [Railway template](../infra/railway/README.md) |
| `wuying` | `WUYING_*` (below) | One existing Wuying cloud computer (Windows) |

Remote paths still need a working API/worker; they do not replace Postgres or
the web UI. They require egress to the provider. For air-gapped hosts prefer
`docker` with pre-loaded images, or `none`.

A run starts its computer only when it first uses a computer tool. With idle sleep on,
a computer suspends after `SANDBOX_IDLE_MS` idle. On providers that bill while running
(E2B, Daytona, Boat, boxd, CreateOS, Railway), it also suspends after `COMPUTER_MAX_ACTIVE_MS`
(default 2 hours) up in one stretch, even with background work or an open screen, unless
a run is executing on it, a user is in control of its screen, or a coding agent CLI (Codex,
Claude Code, OpenCode) wrote its session within the last `SANDBOX_IDLE_MS`. An agent waiting
at its prompt writes nothing, so it does not hold the computer. `0` turns the cap off.
That exception lifts only the uptime cap; idle suspension after `SANDBOX_IDLE_MS` still
applies once nothing holds the computer.
Docker and this-Mac computers are never capped. The next use resumes it. Asking for
takeover restarts the idle timer, and on providers that do not bill while running the run
also holds the computer for 30 minutes after asking, so the user can answer the push on
the same open page.

### Computer run time

Each stretch a computer runs at its provider is a row in `computer_runs`, attributed to the
computer's owner and space. A run starts when the computer becomes ready (boot time is not
counted) and ends when it stops. `endReason` says how: `stopped`, `idle`, `active_limit`,
`replaced` (update, recovery, or reset), `gone` (the provider had already stopped or lost
the sandbox), `deleted`, or `reconciled` (the end was never seen; the worker found the
computer no longer running). For `gone` and `reconciled`, `endedAt` is when Rakazo
noticed, so the true end may be earlier. The worker also opens the run of a running
computer whose start was not recorded. An open run whose computer still reads as running
is a computer that may be left on. Deleting a user or space keeps their runs with
`userId` and `spaceId` cleared. This-Mac computers are not recorded.

The table has row-level security, so query it as the database owner. Timestamps are UTC.
Run hours per user over the last 7 days, counting runs still open up to now:

```sql
WITH now_utc AS (SELECT now() AT TIME ZONE 'UTC' AS at)
SELECT r."userId", u.email,
       round(sum(extract(epoch FROM
         coalesce(r."endedAt", n.at) - greatest(r."startedAt", n.at - interval '7 days')
       )) / 3600, 1) AS hours
FROM computer_runs r
CROSS JOIN now_utc n
LEFT JOIN "user" u ON u.id = r."userId"
WHERE coalesce(r."endedAt", n.at) > n.at - interval '7 days'
GROUP BY r."userId", u.email
ORDER BY hours DESC;
```

Runs open longer than 6 hours:

```sql
SELECT r."computerId", r."userId", r."spaceId", r.kind, r."startedAt",
       round(extract(epoch FROM (now() AT TIME ZONE 'UTC') - r."startedAt") / 3600, 1) AS hours_open
FROM computer_runs r
WHERE r."endedAt" IS NULL
  AND r."startedAt" < (now() AT TIME ZONE 'UTC') - interval '6 hours'
ORDER BY r."startedAt";
```

### Linux background-work inspection

The fallback background-work probe and cancellation commands require Bash,
Python 3.7 or newer, and a readable/searchable `/proc` root. Both supplied images
install `python3` explicitly in `infra/sandboxes/computer/Dockerfile` and
`infra/sandboxes/desktop/Dockerfile`. Custom and remote images must provide this
capability. The scanner itself never installs Python.

The scanner reads marker file descriptors regardless of the holder's UID,
including duplicated, inherited, and deleted-but-open markers. Individual
entries that disappear or deny access are skipped because their links cannot
be observed. A failed root traversal, unexpected filesystem error, or missing
Python capability makes inspection unknown. Such failures do not authorize marker
cleanup or cancellation signals from partial scanner output. Cancellation
rechecks each selected PID's marker descriptors before signaling it.

### E2B computer template

E2B computers start from the `rakazo-computer` template: E2B's stock desktop at
2 vCPU and 4 GB instead of its 8 vCPU and 8 GB. Build it once in the E2B team that
owns `E2B_API_KEY`, and again whenever its definition in
`packages/adapters/src/e2b-template.ts` changes:

```bash
E2B_API_KEY=<deployment key> pnpm sandbox:e2b-template
```

Until it exists, new computers use the stock desktop template. Existing computers keep
the size they were created with until they are replaced.

### Novita computer template

Set `SANDBOX_PROVIDER=novita` and `NOVITA_API_KEY` on both the API and worker.
Build the desktop template once in the account that owns that key:

```bash
NOVITA_API_KEY=<deployment-key> pnpm sandbox:novita-template
```

The `rakazo-computer` template uses Novita's desktop image at 2 vCPU and 4 GB.
The provider requires this template and does not fall back to the larger stock desktop.
To use another desktop template, set `SANDBOX_TEMPLATE` to the same name when building
and on both services. Rebuild when the template definition changes; existing computers
keep their original template and resources.

Computers pause on idle timeout and on stop, preserving files, browser profiles, and
running-process memory. Reconnecting resumes the same computer. Destruction deletes
it without resuming it. Stop retries pause requests and checks the remote state. Command
cancellation and deadlines retry termination; if termination cannot be confirmed, the
adapter attempts to pause the computer and reports that the command may remain suspended.
An unconfirmed command stop also quarantines the computer in the shared database, so
API heartbeats, worker jobs, and restarts cannot silently resume it. Use the existing
Recover or Reset action to replace it from saved work; the paused guest is preserved
until that explicit action. Normal reads and heartbeats do not resume a paused Novita
computer.
An outage can prevent both operations; the configured idle timeout remains the final
auto-pause boundary. This recovery does not delete the saved computer. Paused storage remains subject to Novita's storage billing
and retention terms. This provider uses the shared Linux desktop runtime for screens,
takeover, terminal, and portable workspace transfer.

A missing key disables computers without preventing startup. A present but invalid key,
a missing template, or a quota failure surfaces when a computer starts; an authentication
or network error does not authorize replacing an existing computer.

### Boat computer snapshot

Boat computers start from a named snapshot, `rakazo-computer-<hash>`, that already has the
desktop tools installed. The hash follows the setup in `packages/adapters/src/boat-sandbox.ts`,
so changing it produces a new name and existing computers keep the one they started from.

No setup is needed: when the snapshot for the current setup is missing, the API or worker
logs `sandbox.base_image` with `outcome: "missing"`, builds it once in the background from a
fresh sandbox with no account environment and no bot data, and deletes the build sandbox.
Until it is ready, new computers install the tools themselves. To build it ahead of the
first computer, in the Boat account that owns `BOAT_API_KEY`:

```bash
BOAT_API_KEY=<deployment key> pnpm sandbox:boat-snapshot
```

### boxd computers

boxd computers are isolated microVMs: no boxd credentials inside, and no route to the
account's other machines. They start from a snapshot, `rakazo-computer-<hash>`, with the
desktop tools and Chrome installed, built the same way as Boat's: once in the background
when missing, from a fresh machine that is deleted afterwards. To build it ahead of the
first computer:

```bash
BOXD_API_KEY=<deployment key> pnpm sandbox:boxd-snapshot
```

The desktop is served on the machine's own public HTTPS address; every screen and terminal
still needs its own token, which the desktop gateway checks. Stopping a computer suspends it
with its memory, so programs it was running continue when it resumes.

## Verify a provider change

After changing provider or keys (from the published-images drop directory that
holds `docker-compose.images.yml` and `.env`):

```bash
docker compose --env-file .env -f docker-compose.images.yml up -d
curl -fsS http://127.0.0.1:3100/internal/health
```

Confirm `sandbox` equals the intended provider (`e2b`, `novita`, `daytona`, `boat`, or `boxd`).
HTTP 200 alone does not verify a remote provider: a missing API key falls back to `sandbox: "none"`.
A present but invalid key still reports the selected provider. Open a bot's computer to verify
provisioning and desktop access.
