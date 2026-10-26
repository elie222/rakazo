# Self-host sandbox / computer providers

`SANDBOX_PROVIDER` selects where bot computers run. Workspace bots share a Team Computer by
default; Private Computers are optional. See [computer runtime and isolation](./computer-runtime.md)
for the sharing and persistence contract.

## Quick pick

| Goal | Set | Also need |
| --- | --- | --- |
| Local Docker computers | `SANDBOX_PROVIDER=docker` | `SANDBOX_SUPERVISOR_TOKEN`, computer image, Docker socket for supervisor |
| UI only, no computers | `SANDBOX_PROVIDER=none` | No provider credential; published-images Compose still requires `SANDBOX_SUPERVISOR_TOKEN` |
| Managed remote desktop | `e2b` / `novita` / `daytona` / `boat` | `SANDBOX_SUPERVISOR_TOKEN` (published-images Compose), matching API key (and optional URL knobs for Daytona/Boat) |
| One pod per computer on your own cluster | `SANDBOX_PROVIDER=kubernetes` | API and worker running in the cluster, a namespace and a Role that can create, read, delete and exec into pods |

Published-images [Compose](../infra/compose/docker-compose.images.yml) defaults to **`docker`**.
It always starts the supervisor and requires `SANDBOX_SUPERVISOR_TOKEN`, including for `none`
and remote providers. This stack credential does not replace a remote provider's API key.

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

Remote paths still need a working API/worker; they do not replace Postgres or
the web UI. They require egress to the provider. For air-gapped hosts prefer
`docker` with pre-loaded images, or `none`.

A run starts its computer only when it first uses a computer tool. With idle sleep on,
a computer suspends after `SANDBOX_IDLE_MS` idle. On providers that bill while running
(E2B, Daytona, Boat, CreateOS, Railway), it also suspends after `COMPUTER_MAX_ACTIVE_MS`
(default 2 hours) up in one stretch, even with background work or an open screen, unless
a run is executing on it or a user is in control of its screen. `0` turns the cap off.
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

## Verify a provider change

After changing provider or keys (from the published-images drop directory that
holds `docker-compose.images.yml` and `.env`):

```bash
docker compose --env-file .env -f docker-compose.images.yml up -d
curl -fsS http://127.0.0.1:3100/internal/health
```

Confirm `sandbox` equals the intended provider (`e2b`, `novita`, `daytona`, or `boat`).
HTTP 200 alone does not verify a remote provider: a missing API key falls back to `sandbox: "none"`.
A present but invalid key still reports the selected provider. Open a bot's computer to verify
provisioning and desktop access.
