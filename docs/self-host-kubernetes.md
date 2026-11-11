# Run Rakazo and its computers on k3s

English | [한국어](./ko-KR/self-host-kubernetes.md)

You sign in, open a bot, and click **Computer**. The app loads, but the computer
stays dark. Is it still starting? Or did the login page get in the way of the screen?
These are different problems. This guide builds the installation one step at a
time so you can tell them apart—and fix configuration instead of patching the app.

## First, give the app somewhere to run

On one machine, Rakazo needs a database, an API, a worker, and a web server. Moving
those processes into a cluster does not change their jobs. Kubernetes runs each in
a managed unit called a **Pod**, and a **Service** gives it a stable internal address.

A bot's computer is another Pod. The API and worker ask Kubernetes to create it,
run commands in it, and remove it when finished. This is the existing
[`kubernetes` computer provider](./self-host-sandbox-providers.md#kubernetes);
there is no Docker socket or new application code in this recipe.

```text
Browser → HTTPS edge / optional login gate → private ingress → web
                                                            ├─ API → PostgreSQL
                                                            └─ computer screen
                                                               ↑
                                          API + worker → Kubernetes API
                                                       → computer Pods
```

The [example](./examples/kubernetes/) targets a **fresh, dedicated, single-node
k3s installation**, with local storage and one replica of each app process. It is
not an HA chart or an overlay for an existing Rakazo namespace. API and worker
share one data volume on the same node; spreading replicas across nodes requires a
new storage design. Do not apply it to namespaces containing existing data.

Before starting, confirm:

- Kubernetes **1.35+**, the stable `ValidatingAdmissionPolicy` API, and cluster-admin
  access for initial setup. The policies pin the Pod Security baseline to v1.35.
- The `local-path` storage class, CoreDNS in `kube-system` with `k8s-app=kube-dns`,
  and Traefik there with `app.kubernetes.io/name=traefik`. Adapt selectors for your cluster.
- A network plugin that enforces NetworkPolicy. k3s network-policy enforcement must
  be enabled. A YAML policy alone does not prove packets are blocked.
- Enough free disk for images, database, saved homes and two running computers.
  Each computer is limited to 2 CPUs / 4 GiB; allow room for the app and the node too.
  See [resource sizing and diagnosis](#size-resources-and-investigate-slow-tasks) before choosing limits.
  Local-path PVC sizes are requests, **not disk quotas**. Monitor actual filesystem space.

The app and computer digests in the example are a matching published pair from
revision `235018325032825a5e12f856c4ac0481c168aa5d`. They are a reproducible starting
point, not a promise of the latest release. When upgrading, select a matching pair,
update every app image (including Jobs) and the computer image setting, and review
release notes and migrations. PostgreSQL is pinned separately to version 18.

## Prepare settings before starting anything

From a checkout of this repository:

```sh
cd docs/examples/kubernetes
cp config.env.example config.env
cp installation.env.example installation.env
cp migration.env.example migration.env
```

Edit `config.env`: replace `app.example.com` in all public URL settings and replace
both owner email values. Keep API, web and screen paths on the same HTTPS origin.
`SIGNUPS_ENABLED=false` closes public registration; the bootstrap Job will create
the first account without opening it temporarily.

The controller also needs to reach the cluster API. Inspect its actual endpoint:

```sh
kubectl get endpoints kubernetes -n default -o wide
```

Set `KUBERNETES_API_CIDR` in `installation.env` to that endpoint's IPv4 `/32`.
The example permits TCP 6443 to it for API and worker only. Change the port/rules
if your endpoint differs; do not solve a timeout by allowing the whole private network.
Your CNI's Service translation can affect which address a policy sees; test it.

Also set `TRUSTED_PROXIES` for the actual forwarding chain. Otherwise, with
containerd the API can treat every request as coming from the web Pod: unrelated
users share a sign-in rate-limit bucket and security logs record that proxy.
The example adds two **headless Services**, whose DNS resolves the web and Traefik
Pod IPs instead of a virtual Service IP. Keep their selectors aligned with your
cluster, and replace `192.0.2.20/32` with the edge's actual address as seen in the
forwarded chain. Add other verified proxy hops, such as an OAuth proxy or SNAT node,
individually. Do not trust all private ranges or the whole shared Pod network.
The internet-facing edge must discard client-supplied forwarding headers; configure
inner proxies to accept forwarding information only from their trusted predecessors.
Check an actual client IP in session/security records before exposing the service.

Next create independent secrets **once**. This writes a private file without
printing passwords or placing them in shell arguments. It refuses to overwrite an
existing file. Back it up securely before deployment; losing `ENCRYPTION_KEY` can
make encrypted data unreadable.

```sh
python3 - <<'PYTHON'
import os, secrets
owner = secrets.token_hex(24)
runtime = secrets.token_hex(24)
values = {
    "POSTGRES_PASSWORD": owner,
    "DATABASE_MIGRATION_URL": f"postgres://rakazo:{owner}@rakazo-postgres:5432/rakazo",
    "DATABASE_URL": f"postgres://rakazo_app:{runtime}@rakazo-postgres:5432/rakazo",
    "ENCRYPTION_KEY": secrets.token_hex(32),
    "BETTER_AUTH_SECRET": secrets.token_hex(32),
    "SCREEN_PROXY_SECRET": secrets.token_hex(32),
    "OWNER_PASSWORD": secrets.token_hex(24),
}
fd = os.open("secrets.env", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, "w") as file:
    file.writelines(f"{key}={value}\n" for key, value in values.items())
PYTHON
```

These local `.env` files are ignored by Git. Rendered manifests contain a base64
copy of the secrets; that is encoding, not encryption. Do not paste them into
issues or commit them. Use cluster secret encryption and restrict Secret access.
The owner database login is given only to PostgreSQL and the migration Job; app
processes receive the separate runtime login.

## Start in an order you can check

Apply one phase, then wait for its result. Do **not** apply the whole directory
without a label selector: migration, account creation and app startup have dependencies.

```sh
# Namespaces, storage, credentials, policies, internal Services, and database.
kubectl apply -k . -l rakazo.example/phase=foundation
kubectl -n rakazo rollout status deployment/rakazo-postgres --timeout=300s

# Create schema, queue tables, and the restricted runtime database role.
kubectl apply -k . -l rakazo.example/phase=migrate
kubectl -n rakazo wait --for=condition=complete job/rakazo-migrate --timeout=300s

# Start the application against the prepared database.
kubectl apply -k . -l rakazo.example/phase=app
kubectl -n rakazo rollout status deployment/rakazo-api --timeout=300s
kubectl -n rakazo rollout status deployment/rakazo-worker --timeout=300s
kubectl -n rakazo rollout status deployment/rakazo-web --timeout=300s

# Create the private owner account and leave public signup closed.
kubectl apply -k . -l rakazo.example/phase=bootstrap
kubectl -n rakazo wait --for=condition=complete job/rakazo-bootstrap --timeout=300s
```

A completed migration Job means the database is prepared; it does not mean the
screen is ready. If a phase fails, inspect that Job/Pod's events and logs before
continuing. First image pulls can take minutes. Increasing the rollout timeout
helps a slow download; it will not fix `ImagePullBackOff` or a denied Pod.

No public Ingress is included deliberately. First arrange a **private** route from
your edge to the `rakazo-web` Service on port 5173 through Traefik. Enforce that only
the edge can reach that ingress (private tunnel/firewall or an authenticated origin
gateway). A hostname check alone is not an access control. Never expose PostgreSQL,
the API Service, Kubernetes API, or computer Pod ports on the internet.

The namespace policy allows Traefik to reach web; it does not restrict who can
reach Traefik itself. Validate the origin restriction before publishing DNS. The
edge must preserve the public Host and forwarded HTTPS scheme, and support
WebSocket upgrades. See [production deployment](./self-host-production.md).

## Add a login gate without breaking the computer

Now imagine adding Google login in front of the domain. A normal page has a login
cookie, so it passes. The computer is displayed in an isolated browser frame;
its requests can arrive **without that outer cookie**. Sending those requests to
Google produces a login redirect where the app expected a screen or WebSocket.
Waiting longer cannot fix that redirect.

How can a screen request prove permission without that cookie? Rakazo already
issues a short-lived, encrypted URL after checking the app session. The URL carries
permission for a particular screen: a **bearer capability**. Anyone holding it can
use that permission until it expires or is invalidated. The web proxy and API check
it, including the current computer/session generation, lifecycle and control lease.

Keep outer login on normal pages and API requests. Route **only**
`/novnc/session/*` directly to Rakazo's web proxy so Rakazo can validate its own
capability. Keep `SCREEN_PROXY_SECRET` identical in API and web, and distinct from
the app auth secret. Do not relax frame sandboxing or `X-Frame-Options`.

The [Caddy example](./examples/kubernetes/Caddyfile.edge.example) uses two exclusive
[`handle` routes](https://caddyserver.com/docs/caddyfile/directives/handle):

- `RAKAZO_PRIVATE_UPSTREAM`: your edge-only ingress, including its port.
- `RAKAZO_AUTH_UPSTREAM`: your local oauth2-proxy, forwarding to that same ingress.
- `RAKAZO_PUBLIC_HOST`: the public domain, for example `app.example.com`.

Set these in the Caddy process environment. The matcher preserves the full path;
Caddy's [reverse proxy supports WebSockets](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy).
Do not broaden the exception to `/novnc/*`, `/api/*`, or a whole hostname. It bypasses
only the **outer cookie check**, not Rakazo's screen authorization. Keep all screen
URLs out of access logs, analytics, error reports and shared screenshots, at every
proxy layer. The example sets `no-store` and `no-referrer` and enables no access log;
adapt any existing global logging/CDN rules too. Stop the computer to invalidate a
leaked capability; logging out of Google alone does not revoke an already issued one.

For an optional Google gate, follow the
[oauth2-proxy Google provider setup](https://oauth2-proxy.github.io/oauth2-proxy/configuration/providers/google/):

1. Create a Google OAuth **Web application** client. Register the exact callback
   `https://app.example.com/oauth2/callback` after substituting your domain. Configure
   the consent screen and, while testing, add your own account as a test user.
2. Give the client ID and secret to **oauth2-proxy**, not Rakazo's app OIDC settings.
   Use its Google provider, HTTPS redirect URL, secure cookies, reverse-proxy mode,
   and a separately generated cookie secret. Bind it privately and set its upstream
   to your edge-only ingress.
3. Set `authenticated_emails_file` to a private file containing only your full email
   address. Do not also configure wildcard/domain-wide allowances: they can widen
   admission. A Google test-user list is not a replacement for the proxy allowlist.
4. Test your allowed account, a different account, and a signed-out browser. The
   allowed account should reach Rakazo's own login; use `OWNER_EMAIL` and the saved
   `OWNER_PASSWORD` there. Outer Google login does not create a Rakazo session.

### Connect the mobile app through the same gate

A browser can complete Google's login page. The native app instead sends a server
probe to `/rpc/health` and expects JSON. A redirect to Google is not that response,
even if Safari on the same phone is already signed in.

The app already has **Server → Headers** for an access proxy's credentials. Give
that device a separate entry key; keep Rakazo's account login behind it. In the
Caddy example, the optional `@native` route requires **both** a matching
`X-Access-Key` and an `/api/*` or `/rpc/*` path. Missing/wrong keys still go through
the Google gate. An unset or malformed configured key leaves this route disabled.

Generate 32 random bytes as 64 lowercase hex characters using your secret manager
(or `python3 -c 'import secrets; print(secrets.token_hex(32))'` in a private terminal).
Store it securely as `RAKAZO_NATIVE_ACCESS_KEY` in the **Caddy process environment**,
then validate and reload Caddy. With containers, changing an env-file normally
requires recreating the Caddy container to update its process environment; an
in-process config reload alone does not import a changed external env-file. Plan
for the connection interruption. Never reuse `SCREEN_PROXY_SECRET`, the app auth
secret, or a private-origin credential.

On the phone, enter the HTTPS server origin, add **Header name** `X-Access-Key` and
put the generated value in **Header value**, then save. Sign in with the existing
Rakazo account. The app stores configured headers securely, scopes them to that
server, and refuses redirects on requests carrying them. The edge strips this key
before forwarding; Rakazo still checks the separate app session and permissions.
Do not use an `X-Rakazo-*` name: the client reserves those headers for the app.

Verify four different results: no key → Google gate; wrong key → Google gate;
correct key → JSON health response; correct key without an app session → protected
RPC denied. Then test native sign-in and the desktop screen on the actual phone.
A successful server probe alone does not prove the entire mobile workflow.

Treat the entry key like a password. Keep it out of logs and screenshots; deliver
it through a private password manager. This example has one native key; for
multiple devices use separate revocable credentials in your access proxy. To
revoke it, remove/rotate the key in Caddy's actual process environment and apply
the configuration, then revoke the device's Rakazo session too. Browser Google
logout does not revoke this independent device credential.

External webhooks and other integrations require their own authentication design;
do not add broad unauthenticated API exceptions. App-native SSO is a separate
option in [sign-in and accounts](./self-host-accounts.md).

## Size resources and investigate slow tasks

A task stops even though the server still has free memory. The API, worker and
each computer run in separate containers, each with its own ceiling. Free host
memory does not allow a container to exceed its limit. A memory limit can lead to
an out-of-memory (OOM) kill; a CPU limit can instead make a busy container wait
for more CPU time. Neither symptom alone explains every slow task.

In one existing deployment, the API and worker were each limited to 2 GiB and
were killed during large bot/file jobs despite spare host memory. Kernel records
matched the kills to their container memory limits. The cause of the memory growth
is unknown. Raising the limits and checking readiness and sign-in did not measure
long-term stability or prove faster tasks.

The files in this example start smaller. For a memory-heavy workload with enough
capacity, the following **observed larger profile** is a starting point to evaluate,
not a minimum or a performance guarantee:

| Setting | Example default | Larger profile used in that deployment |
| --- | --- | --- |
| API and worker, each (`workloads.yaml`) | requests 100m CPU / 128 MiB; limits 2 CPU / 2 GiB | requests 1 CPU / 1 GiB; limits 4 CPU / 8 GiB |
| Each computer (`config.env`) | limits 2 CPU / 4 GiB | limits 4 CPU / 8 GiB |
| Computer namespace (`limits.yaml`) | 2 Pods; limits total 4 CPU / 8 GiB | 2 Pods; limits total 8 CPU / 16 GiB |

A **request** is what the scheduler uses to place a Pod; a **limit** is its
runtime ceiling. The computer provider supplies CPU and memory limits without
separate requests, so Kubernetes normally copies each limit into its request when
no admission policy supplies another request. Two larger computers plus API and
worker therefore request 10 CPUs and 18 GiB, before the web server, database,
Jobs, Kubernetes and other workloads. A node can have free memory now and still
lack allocatable capacity for the requests; the Pod then remains Pending. Check
node allocatable resources and other Pods' requests as well as current use;
`kubectl describe node <NODE>` shows both. The namespace quota is a total, not a
per-computer setting: increasing a computer limit without increasing the quota
can prevent a second computer from starting.
The per-user computer limit is separate from that namespace-wide quota.

To use the larger profile, edit both API and worker resources in `workloads.yaml`,
set `KUBERNETES_SANDBOX_CPU_LIMIT=4` and `KUBERNETES_SANDBOX_MEMORY_LIMIT=8Gi`
in your local `config.env`, and change `limits.cpu` to `'8'` and `limits.memory`
to `16Gi` in `limits.yaml`. Keep the Pod and ephemeral-storage quota values unless
you intend to change them. Review node capacity and capacity for other services
first. Apply the foundation phase before the app phase as shown above. The changed
Deployment templates roll out new API and worker Pods; allow running work to finish
before replacing a worker. A ConfigMap update alone does not refresh their process
environment: restart both Deployments if only `config.env` changed. Existing
computers keep their creation-time settings; stop them cleanly to save their homes,
then create them again for the new limits. A supported in-place resize is a separate
operator action and may be deferred or require a restart.

For rollback, save computer work. Restore the old `config.env` and API/worker
resources while temporarily keeping the larger quota, then apply foundation and
app after worker tasks finish. Recreate the stopped computers with the old limits;
do not shrink their memory limits while they run. Once quota usage fits the old
values, restore `limits.yaml` and apply foundation again. Verify the rollouts and
continue monitoring: a higher ceiling can delay another OOM without fixing the
underlying growth.

Start diagnosis with the part that stopped. These read-only commands use the
example's namespaces and names; use your own deployment names where they differ.

```sh
kubectl -n rakazo get pods
kubectl -n rakazo-sandboxes get pods
kubectl -n rakazo-sandboxes describe quota rakazo-computers
kubectl top nodes
kubectl -n rakazo top pods
kubectl -n rakazo-sandboxes top pods
```

`kubectl top` needs a working metrics-server and shows a recent sample, not a
history or peak. For a Pod with a restart or Pending status, use `kubectl -n
<NAMESPACE> describe pod <POD>` to inspect events, resource settings and its last
terminated reason. `OOMKilled` is evidence of an OOM; exit code 137 by itself is
not. To distinguish a container limit from node-wide pressure, correlate the time
and container with node/kernel OOM records where available (for example, a matching
`CONSTRAINT_MEMCG` record). Events and previous container logs may have expired;
`kubectl -n <NAMESPACE> logs <POD> -c <CONTAINER> --previous` can help when they
remain. Substitute actual names; these angle-bracket placeholders are not literal
shell arguments. Logs, events and screen URLs can contain private data: inspect and
redact them before sharing.

If the Pod has not started, check image pulls, admission, quota, node scheduling
and disk. If it runs but a task is slow, separate queue wait, time to first response,
tool execution and screen/network delays. Check the database, disk and external
model or network waits too. In the incident above, one first response took about
100 seconds while recorded queue wait was under a second; that does not assign
the remaining time to the model service. Compare repeated observations and
resource history before changing limits or concluding CPU throttling is the cause.
If available, compare the container's CPU throttling counters over the same time
interval; a cumulative counter alone does not establish current throttling.

## Find the failing boundary before changing a setting

| What you observe | What to inspect | What to do next |
| --- | --- | --- |
| Computer Pod is Pending | `kubectl -n rakazo-sandboxes get pods` and Pod events | Check image pulls, quota, scheduling and disk. Wait while progress continues. |
| No computer Pod appears | API/worker logs and admission events | Check scoped RBAC, API endpoint policy and image admission rule. Do not grant cluster-admin to the app. |
| Pod runs, but no internal screen | Pod logs, ports 6080 and 6100–6199, web egress policy | Check gateway startup and cross-namespace reachability. Pod Running alone is insufficient. |
| Internal screen works, public screen redirects to Google | Browser Network tab, without sharing the capability URL | Correct only the `/novnc/session/*` edge route. |
| Public screen gets 403 | API/web secret agreement, token expiry, computer generation | Reopen Computer for a fresh URL. Keep authorization checks enabled. |
| Page loads, screen freezes | WebSocket request and edge timeouts | Confirm upgrade forwarding and a 101 response for an authorized live session. |
| Files vanish after abrupt Pod loss | Saved workspace/checkpoint and backups | Restore the last saved home; changes since it may be lost. |

Before calling the deployment ready, use a real browser signed into Rakazo at its
public origin: open Computer, view the desktop, take control and type, then reconnect.
A synthetic iframe on an unrelated origin is not an equivalent test of frame policy.
Signed-out `/`, `/api/...` and `/novnc/` should still hit the outer gate. A cookie-less
`/novnc/session/view/not-a-token/vnc.html` must fail closed (403), never show a screen.
Also verify a stopped/expired session cannot be reused. Avoid recording real tokens.

## Keep the bot's computer inside its boundary

The example gives API and worker permission to create/get/delete Pods and execute
commands only in `rakazo-sandboxes`. A separate admission policy limits what those
credentials can create: the pinned computer image, no host mounts, no extra
containers, no service-account token, and no Secret-based environment variables.
It reads the allowed image from `rakazo-config`; missing parameters deny creation.
The two-computer quota and limits cap capacity. A per-user limit alone would not
cap every user together.

NetworkPolicy allows DNS and public HTTP(S) from computers, and blocks private
IPv4 ranges in that allow rule; it grants no IPv6 egress. **Node-local traffic and
metadata access need host/CNI controls too**: Kubernetes policy alone is not a
universal host firewall. Verify from an actual computer that intended websites
work while node SSH, cluster API, databases, private networks and metadata endpoints
are inaccessible. DNS queries and public destinations remain possible; this is not
an exfiltration prevention policy. Restrict egress further for your threat model.

These are ordinary containers sharing the host kernel. For stronger separation,
install and test a sandbox runtime first, then set
`KUBERNETES_SANDBOX_RUNTIME_CLASS_NAME`. Setting a name does not install a runtime.

This recipe uses saved-home **checkpoints**: files are copied into the computer on
start and saved back on orderly stop. A Pod is disposable; unsaved changes may not
survive a crash. The volume-free admission rule deliberately rejects the optional
mounted-home mode. Do not set `KUBERNETES_SANDBOX_HOME_CLAIM` without redesigning
namespace, volume and admission boundaries together.

## Change configuration and recover deliberately

ConfigMaps and Secrets have stable names here. Updating them does not update a
running process's environment: apply the foundation phase, then restart the affected
Deployments. Stop computers cleanly first when changing computer settings; an
existing Pod keeps its creation-time image and limits.

A migration can finish while a new app release fails to start. The database has
seen the new migration, but the old app may still need the column it proposes to
drop. Therefore the next attempt must know the **last fully deployed release**,
not just which migrations have run.

The migration Job always reads `RAKAZO_DEPLOYED_MIGRATIONS` from the dedicated
`rakazo-migration-state` ConfigMap, generated from `migration.env`. The initial empty
value is explicit: on a nonempty database it conservatively keeps deferred drops
held back. A missing ConfigMap/key stops the Job instead of omitting the safeguard.
Do not replace this file with the empty example on each upgrade.

After initial installation—and after each **fully verified** upgrade with all old
API/worker instances stopped—record the running release's inventory:

```sh
# Run in docs/examples/kubernetes. Keep the previous file with the release backup.
python3 - <<'PYTHON'
from pathlib import Path
import subprocess
script = ('const fs=require("node:fs");'
          'process.stdout.write(fs.readdirSync("/app/packages/db/prisma/migrations",'
          '{withFileTypes:true}).filter(e=>e.isDirectory())'
          '.map(e=>e.name).sort().join(","))')
inventory = subprocess.check_output([
    "kubectl", "-n", "rakazo", "exec", "deployment/rakazo-api", "--", "node", "-e", script
], text=True).strip()
if not inventory or "\n" in inventory:
    raise SystemExit("No valid deployed inventory; existing migration.env was preserved")
Path("migration.env.next").write_text("RAKAZO_DEPLOYED_MIGRATIONS=" + inventory + "\n")
Path("migration.env.next").replace("migration.env")
PYTHON
```

Do not advance this inventory after migration alone or a failed rollout. Before the
next migration, apply the foundation phase to load the saved inventory, then create
the newly named migration Job. If rolling back app images, restore the inventory
belonging to that release too. If the inventory is lost, use an explicit empty value
until the active release is established; never unset the variable as a shortcut.

For an upgrade, back up PostgreSQL, the data PVC and encryption keys first; test a
restore. Drain running worker jobs before replacing the worker, as described in
[upgrading](./self-host-upgrading.md). Update the pinned images, use a fresh migration
Job name, wait for its success, then roll out the app. Jobs have immutable Pod
templates; reapplying an old completed Job is not a new migration run. Bootstrap is
for initial account creation, not password rotation.

Keep the previous image/configuration and backup together. Application rollback
requires database compatibility; restoring only an old image cannot undo a schema
change. Never use namespace/PVC deletion as a retry procedure. See
[backup and restore](./self-host-backups.md) for the data recovery boundary.

When the app opens but the screen does not, you now have three things to check in
order: whether the computer started, whether web can reach it, and whether the edge
let its capability reach Rakazo. Each has its own configuration and evidence.
