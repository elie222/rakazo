# Self-hosting Rakazo

The signed-in product is a long-running API, a Graphile Worker, Postgres, and a computer provider (Docker supervisor, E2B, Daytona, CreateOS, or Boat). It is not a static site. The marketing site in `apps/www` can be hosted separately.

## Local (source checkout)

Same as the README quick start: `.env` from `.env.example`, Postgres via Compose, `pnpm sandbox:build`, `pnpm dev`, then [http://127.0.0.1:5173](http://127.0.0.1:5173) (or `http://localhost:5173` — both loopback hosts are trusted). Electron: `pnpm --filter @rakazo/desktop dev` while that stack is up, choosing **Existing instance** with that address. The desktop app's **This computer** option instead installs and runs the published images itself with Docker Compose (see [Published images](#published-images-no-checkout)), using port 45173 by default so it can run alongside `pnpm dev`. If that port is occupied, the app selects and remembers another loopback port. The managed API gets a Docker-assigned loopback port; all desktop traffic uses the web origin.

For source development in WSL, keep the checkout and `data` directory in the Linux filesystem (for example, `~/rakazo`), and run `pnpm dev` as your normal user. The host-run supervisor matches bot container UID/GID to that user. If Docker Desktop container IPs are unreachable, set `SANDBOX_CONTROL_VIA_LOOPBACK=true` in `.env`; this publishes the token-protected control service on a random loopback port. Leave this unset for the Compose-hosted supervisor.

Compose bot homes mount only their own subdirectory of the application volume using Docker volume semantics. Docker's internal volume paths are never used as host bind mounts.

## Published images (no checkout)

Pull Postgres and `ghcr.io/elie222/rakazo/app` into any empty folder. No clone or image build.
Requires Docker Engine 26+ (API 1.45+ for bot home volume subpaths), the Compose plugin, curl, and OpenSSL.

```bash
mkdir -p rakazo && cd rakazo &&
curl -fsSLO https://raw.githubusercontent.com/elie222/rakazo/main/infra/compose/install-images.sh &&
bash install-images.sh
```

The installer downloads `docker-compose.images.yml` and `.env.images.example`, creates `.env` with
random secrets, then pulls and starts the images. It preserves an existing `.env` when rerun. For
the installer secret list, non-reuse rules, and recovery, see
[Self-host secrets checklist](./self-host-secrets.md). To customize the public URL, image tag, or
optional providers before startup, run `bash install-images.sh --prepare-only`, edit `.env`, then
run `bash install-images.sh`. Flags may be combined in either order: `--prepare-only`, `--local`.

`SANDBOX_PROVIDER` defaults to `docker`. The images Compose file runs a sandbox supervisor
(from the app image, on the internal network only) and pulls `ghcr.io/elie222/rakazo/computer`.
Signup and local Docker computers work without an E2B account. Optional remote providers: set
`SANDBOX_PROVIDER` to `e2b`, `daytona`, `createos`, or `boat` and add the matching API key. The published-images
Compose stack requires `SANDBOX_SUPERVISOR_TOKEN` for every provider; leave it empty and `compose up` fails closed.

Optional: set `OPENROUTER_API_KEY` or connect a model in the UI after signup.
A provider that authenticates from the host needs no key: for Amazon Bedrock with an ECS task,
IRSA or EC2 instance role, opt in with `PI_DEFAULT_CREDENTIALS=host` and set
`PI_DEFAULT_PROVIDER=amazon-bedrock`, `PI_DEFAULT_MODEL` and `AWS_REGION`. With an instance
role, keep [restricted computer egress](#restricted-computer-egress) on so bot computers
cannot read the role's credentials from the metadata endpoint.
Auto Review uses that LLM checker by default. To use TypeSafe Jev instead, set
`RAKAZO_AUTO_REVIEW_PROVIDER=jev` and `TYPESAFE_API_KEY`. Core still runs with neither.

The example defaults to `edge` (main builds). Every publish is multi-arch (`amd64` + `arm64`), so
arm64 hosts need no special tag. Do not assume `latest` is present until a stable release exists.

Open [http://127.0.0.1:5173](http://127.0.0.1:5173). The first registered user becomes the
deployment owner. Put TLS in front of `:5173` for a public host and set the three public origins to
that HTTPS URL.

Images Compose binds web to loopback (`127.0.0.1:5173`). Terminate TLS on the host and proxy
there. Vite preview same-origin-proxies `/api` and `/rpc`, so do not expose `:3100`. Set
`BETTER_AUTH_URL`, `WEB_ORIGIN`, and `API_URL` to that same HTTPS origin, and set
`RAKAZO_HOST` to its hostname (for example, `app.example.com`).

```Caddyfile
app.example.com {
	reverse_proxy 127.0.0.1:5173
}
```

Open **Agent computer** on a bot, or send a message that uses the desktop, to see
the local Docker computer. For in-stack Caddy plus remote E2B computers, use the
[production Compose](#public-single-vm-deployment) path and `infra/compose/Caddyfile.prod`
instead of this host proxy.

### Restricted networks / mirror downloads

If the installer, Compose downloads, or image pulls are blocked, use the
[restricted-network guide](./self-host-restricted-network.md) for mirror settings and local files.

### Bot computer resource ceilings

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

### Restricted computer egress

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
error or timeout) fails that computer's start and runs again on the next one. An install from before the ruleset existed therefore
keeps working when it upgrades. After installing the ruleset, recreate the supervisor, or set
`restricted` to refuse computers whenever the rules are missing. A host-run supervisor
(`pnpm dev`) and the desktop app's **This computer** stack default to open: Docker Desktop
keeps its bridges in a VM the host rules cannot reach.

Screen streaming is unaffected: the supervisor and web proxy join each computer's bridge,
and the ruleset exempts traffic whose in- and out-interface are both `rakazo-c*` before
any drop (that exemption is load-bearing on hosts where `br_netfilter` feeds bridged
frames through `FORWARD`). Rules match interface names rather than subnets, so computer
create/delete cycles need no firewall maintenance; deleting a computer removes its
traffic from the match and nothing else. A computer provisioned while egress was open
is replaced on its next provision — resuming it on an unnamed bridge would bypass the
restriction.

Computers resolve names through Docker's embedded DNS, which forwards each lookup to the
host's resolvers from inside the computer's network. When the host's resolver has a private
address, as a cloud VPC resolver or a LAN router does, the ruleset drops that forward too and
every lookup times out while connections by IP still work. Set `SANDBOX_COMPUTER_DNS` to
public resolvers (comma-separated IP addresses, such as `1.1.1.1,1.0.0.1`) and recreate the
supervisor: Docker then forwards computers' lookups there, and each computer picks the
servers up on its next provision.

If computers must reach LAN services, an internal proxy, or endpoints bound to the host,
set `SANDBOX_COMPUTER_EGRESS=open`, recreate the supervisor, and run
`sudo bash infra/compose/restrict-computer-egress.sh --remove`. The flag alone does not
uninstall the host rules, which keep matching the still-named `rakazo-c*` bridges until
removed.

The ruleset requires Linux Docker Engine with the iptables backend; Docker Desktop, rootless
Docker, and `firewall-backend: nftables` are unsupported. The
`SANDBOX_SCREEN_NETWORK=internal` topology shares one network instead of per-bot bridges,
so the mode does not apply there.

## Docker Compose (single machine)

1. Copy `.env.example` to `.env` and set `POSTGRES_PASSWORD` and `POSTGRES_APP_PASSWORD` (`openssl rand -hex 16` each), plus `BETTER_AUTH_SECRET`, `ENCRYPTION_KEY`, and `SCREEN_PROXY_SECRET` to independent long random strings (32+ characters; 64 hex for `ENCRYPTION_KEY`). Docker sandboxes also need a dedicated `SANDBOX_SUPERVISOR_TOKEN`. Keep existing `ENCRYPTION_KEY` values so stored credentials stay decryptable.
2. Set `OPENROUTER_API_KEY` (and `COMPOSIO_API_KEY` if you want Plugins).
3. Build the computer image: `pnpm sandbox:build` (Compose also builds it via the `computer` service).
4. `docker compose --env-file .env -f infra/compose/docker-compose.yml up --build`
5. Open the web origin (`http://127.0.0.1:5173` by default). The first registered user becomes the deployment owner.

On Windows, if an older clone with `core.autocrlf=true` leaves the computer pane hung on boot (`bash\r` in sandbox logs): from a clean worktree, set `git config core.autocrlf false`, run `git add --renormalize . && git checkout -- .`, then rebuild with `pnpm sandbox:build`.

Compose runs Postgres, the sandbox supervisor (Docker socket), API, worker, and a Vite preview of the web app. Bot computers are sibling containers (`rakazo/computer:local`) on separate per-bot networks; only the supervisor and screen proxy join each one. The API process does not get an unrestricted Docker socket; the supervisor owns the lifecycle.

Postgres stays on the Compose network only (not published on the host), matching the images
compose. Credentials come from `.env` (`POSTGRES_PASSWORD` is required). Prefer a URI-safe value
(`openssl rand -hex 16`); characters such as `@ : / ? # %` break the interpolated `DATABASE_URL`
inside Compose. Official Postgres images set user, password, and database only on first volume
init, so an existing `pgdata` volume keeps its original identity: keep those values in `.env`, or
change them in place with `ALTER ROLE` / rename. Recreate the volume only after a backup (or when
the data is disposable); `docker compose down -v` deletes all Postgres state. For host-side clients
(`pnpm db:migrate`, GUI tools),
add `infra/compose/docker-compose.postgres-host.yml` so Postgres is published on loopback
`127.0.0.1:5433`, or use
`docker compose --env-file .env -f infra/compose/docker-compose.yml exec postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'`.
Do not publish Postgres on a public interface.

### Database roles

Rakazo uses two Postgres logins:

- The owner (`POSTGRES_USER`, or `DATABASE_MIGRATION_URL` outside Compose) runs migrations and
  owns the tables.
- The app login (`rakazo_app` with `POSTGRES_APP_PASSWORD`, or `DATABASE_URL`) is not a
  superuser, cannot bypass row-level security, cannot create objects, and can only read and write
  the app tables.

`pnpm db:migrate` (in containers, its prebuilt form `pnpm --filter @rakazo/api db:deploy`, which the
API container runs before it starts serving) applies the migrations and the job queue
schema as the owner. It then creates the app login named in `DATABASE_URL`, or updates its
password, and grants it the `rakazo_app` role. When migrations run as a role without
`CREATEROLE`, as on some managed Postgres, create the login yourself and
`GRANT rakazo_app TO <login>`.

Messages, events, threads, memory, artifacts, secrets, model and voice credentials, skills, bots,
runs, tasks, routines, connections, MCP servers and sign-ins, computers, boards and tickets,
messaging identities and outbox, external conversations, steering messages, usage, scratchpad
items and approval rules have row-level security. Each signed-in request sees only its Space's
rows, plus the user's own account-level credentials. A query that leaves out its Space filter
returns nothing from other Spaces. A background job that acts for one run, routine, computer,
skill, thread or cloud agent runs as that row's Space and user, so agent tools get the same
backstop. Security events are written and read only in system scope. Reconcilers, queue sweeps,
the messaging outbox drain and webhooks run in a named system scope (`runAsSystem` in
`packages/db`). The job queue's tables (`graphile_worker`) hold job metadata, not Space content:
graphile-worker turns on row-level security for them, and `pnpm db:migrate` adds a policy that
gives the app login every row.

With only `DATABASE_URL` set, migrations and the app share one login. Everything keeps working,
but `pnpm db:migrate`, the API and the worker warn that row-level security is not enforced. To fix
this, set `DATABASE_MIGRATION_URL` to the owner and `DATABASE_URL` to a new login.

Run `pg_dump` as the owner. The app login would only dump rows it is allowed to see.

The Docker supervisor is not published as its own image and is not exposed on the host. It runs from
the app image, stays on the internal Compose network, and holds the Docker socket because access to
it is equivalent to control of the Docker host. Docker sandboxes require `SANDBOX_SUPERVISOR_TOKEN`
(API, worker, supervisor). `SCREEN_PROXY_SECRET` signs browser-screen capabilities (API and web
proxy). Keep both distinct from `BETTER_AUTH_SECRET`.

New credentials use versioned AES-GCM with per-record salt and row-bound AAD. Legacy ciphertext stays readable.

On a VPS, put TLS in front of `:5173` (or serve the web build behind your proxy) and set:

```env
BETTER_AUTH_URL=https://app.example.com
WEB_ORIGIN=https://app.example.com
API_URL=https://app.example.com
```

Cookies and CORS follow those origins. `SIGNUPS_ENABLED` seeds whether registration is open
when the API starts for the first time and is not reapplied on restart. A non-empty
`SIGNUP_ALLOWLIST` is applied on every API start, replacing the allowlist stored for the deployment.
Leave it empty to keep that stored list.

With a nonempty signup allowlist and SMTP configured, users—including existing accounts—must
verify their email to sign in. Without an allowlist, verification never blocks: a password signup
signs in at once and is sent a verification link that only marks the address verified.

SMTP also enables sign-in with a six-digit emailed code, which expires after ten minutes and allows
three attempts. A code can create an account, so it follows the same registration and allowlist
rules as password signup. Signing in with a code to an existing unverified account removes that
account's password, SSO links and sessions, since nothing proved they belonged to the mailbox
owner. This is what stops someone who registered another person's address from keeping access.

On a fresh instance with no SMTP, the first allowlisted account can register without verification.
That signup does not prove mailbox ownership, so create the account before exposing the service.
Further accounts still need SMTP.

For a public deployment, configure SMTP and an allowlist before the API's first start.
Keep an installation without email on a trusted local network.

### Optional OpenID Connect SSO

SSO works with a self-hosted or hosted OpenID Connect provider. Leave its settings unset to
keep password authentication alone. Configure all three credentials together on the API:

```env
OIDC_ISSUER=https://identity.example.com
OIDC_CLIENT_ID=replace-with-client-id
OIDC_CLIENT_SECRET=replace-with-client-secret
OIDC_NAME=SSO
OIDC_SCOPES=openid email profile
AUTH_PASSWORD_ENABLED=true
OIDC_ALLOW_SIGNUP_BYPASS=false
```

The issuer must be HTTPS and exactly match the discovery document's issuer. Rakazo loads
`<issuer>/.well-known/openid-configuration`, verifies ID tokens against discovery JWKS with
issuer, audience and nonce checks, and uses authorization codes with PKCE. Additional scopes
may be space- or comma-separated; `openid email profile` are always requested. `OIDC_NAME`
is the button label, defaulting to “SSO”. Secrets remain on the API; Compose clears the worker's
OIDC credentials. The capabilities endpoint exposes only the label, discovery availability,
and enabled authentication methods.

Register this redirect URI at the provider (using your public `BETTER_AUTH_URL` origin):

```text
https://app.example.com/api/auth/callback/oidc
```

Web, Electron and mobile use the same provider redirect URI. Electron completes SSO in a
sandboxed in-app popup sharing the app's session, then returns to the main window. Mobile completes the callback
on the API, then returns to `rakazo://sign-in` (or `rakazo://account` for linking and reauthentication) through Better Auth's Expo authorization proxy
and a native auth browser session. The `rakazo` app scheme is trusted by the auth server;
never register a client secret in the mobile app. Mobile stores the resulting session with
SecureStore, like password sign-in. Native builds need the Expo WebBrowser module.

Provider emails are verified only when `email_verified` is the boolean `true`. False or missing
claims stay unverified, including on subsequent sign-ins. Sign-in never links accounts by email.
If an email belongs to another account, sign in to that existing account and choose **Link SSO**
in account settings. Linking requires an authenticated session, a verified provider email and
matching email addresses. The issuer and provider subject identify the linked account thereafter. Changing issuers does
not reuse an old identity. Old-issuer links remain stored but do not count as linked to the
current provider, so **Link SSO** becomes available again. Link the new identity from the
existing signed-in account; authenticated-session, verified-email and matching-email checks
still apply. Restoring the old issuer makes its existing links usable again.

Ordinary SSO sign-in and linking may reuse the identity provider's existing session. They
do not grant fresh authentication proof for account deletion. The account settings' explicit
reauthentication flow requests `prompt=login` and `max_age=0`, binds the callback to the
same linked issuer and subject, and requires the initiating session to remain valid. Only
that callback grants proof to the resulting session, expiring five minutes after provider
authentication (callback delays do not extend it). Its verified
ID token must contain an `auth_time` consistent with that request (allowing 60 seconds of
clock skew) and less than five minutes old. Missing, stale or invalid claims fail closed.
OAuth callbacks are single-use, including concurrent requests. Password verification and
emailed deletion codes remain available. Submit deletion codes through the account settings
or the CSRF-protected `POST /api/auth/delete-user` endpoint; the GET deletion callback is disabled.

SSO signup follows closed registration and the deployment allowlist before creating an account.
Allowlisted provider emails must be verified; the password signup's first-account exemption
never upgrades an OIDC email. `OIDC_ALLOW_SIGNUP_BYPASS=true` explicitly admits IdP identities
without applying the allowlist or its email-verification admission requirement. Enable it only
when the IdP controls who may join this deployment. It does **not** reopen closed registration,
and does not change email verification claims or linking rules. Existing admitted accounts can
sign in while registration is closed.

Set `AUTH_PASSWORD_ENABLED=false` for SSO-only operation. Password sign-in, signup, password
reset and password mutation endpoints are disabled server-side, and sign-in forms are hidden.
The API refuses to start in this mode unless all OIDC credentials are configured. It can still
start while discovery is temporarily unavailable: the provider remains registered, sign-in
returns a temporary error, and background retries recover without restarting. Discovery is lazy
on first use, refreshed in the background, and failures back off up to one minute. Availability
reflects discovery, not a guarantee that the provider's token endpoint is currently reachable.

Account deletion keeps the existing password confirmation for password users. Users without a
password may delete after explicit provider reauthentication within five minutes; **Sign in again** starts a fresh
provider round-trip bound to the signed-in account. Choosing a different identity cannot confirm
deletion or create another account in that flow. A stale or borrowed session alone cannot authorize deletion. With transactional
email configured, **Send deletion code** sends a single-use code to the account email, valid for ten
minutes. Enter it in account settings to confirm deletion. Email-code requests are rate-limited;
invalid, expired or wrong-account codes fail. No password needs to be created for deletion.

### Mobile push notifications

The API and worker send iOS and Android notifications through Expo's push service. If the Expo
project has [enhanced security for push notifications](https://docs.expo.dev/push-notifications/sending-notifications/#additional-security)
enabled, every send needs an access token; without one Expo rejects all pushes. Create an access
token in the Expo account that owns the project and set it for both services:

```env
EXPO_ACCESS_TOKEN=replace-with-your-expo-access-token
```

Leave it unset when enhanced security is off. A missing or revoked token fails the push with an
error that names `EXPO_ACCESS_TOKEN`; the token itself is never logged.

### Verification and password recovery email

Password changes for signed-in users require no email configuration. Forgotten-password recovery
appears on sign-in only when a transactional email provider is available. Rakazo uses a
provider-neutral contract and ships an SMTP adapter, so Amazon SES, Resend, and self-hosted SMTP
servers use the same configuration:

```env
SMTP_URL=smtps://smtp-user:replace-with-password@smtp.example.com:465
EMAIL_FROM=Rakazo <no-reply@example.com>
```

For Resend, use `smtp.resend.com`, username `resend`, and an API key as the password. For Amazon
SES, use the regional SMTP endpoint and SES SMTP credentials; these are different from ordinary AWS
access keys. Verify the sender/domain with the provider before testing delivery. Keep credentials in
`.env`, never in tracked files. `smtps://` uses implicit TLS; `smtp://` is also supported but requires
STARTTLS. Rakazo rejects configuration that disables TLS or certificate verification.

Local source development can use the offline email emulator instead. It captures email without
contacting a provider:

```env
EMAIL_EMULATOR=true
```

The emulator is forcibly disabled when `NODE_ENV=production` and requires the API to bind to a
loopback host. In `NODE_ENV=development`, captured messages are available from
`http://127.0.0.1:3100/api/dev/emails` with cache disabled; the API logs only delivery
metadata, never reset tokens. The inbox route is not registered in test, staging, or production.

### Password policy

New passwords (signup, reset and change) must be 8 to 128 characters, with no composition rules.
Optionally reject new passwords that appear in known breaches:

```env
AUTH_BREACHED_PASSWORD_CHECK_ENABLED=true
```

This queries the Have I Been Pwned range API, sending only the first five characters of the
password's SHA-1 hash. It is off by default so the server makes no outside request. If the service
is unreachable or takes longer than three seconds, the password is accepted and the failure logged.

### Billing

Billing stays off, with no paywall, unless `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and
`STRIPE_PRICE_ID` are all set (see `.env.example`). Setting only some of them stops the API at
startup.

### Pi tracing

Set `OTEL_EXPORTER_OTLP_ENDPOINT` on the worker to enable optional OpenTelemetry traces
(for example, `http://otel-collector:4318`). The OTLP/HTTP exporter appends `/v1/traces`
to the base endpoint and honors standard `OTEL_EXPORTER_OTLP_HEADERS` (comma-separated
`key=value` pairs) and `OTEL_SERVICE_NAME` (default `rakazo-worker`). Compose workers
read these settings from `.env`. With an empty or unset endpoint, no tracing SDK loads
or initializes. No collector or hosted service is required to run Rakazo.

Traces contain a `rakazo.agent.run` span with `pi.ai.request` model-call spans and
`pi.agent.tool` steps, including duration, token usage, cost when known, and success/error
status. Each span carries `rakazo.bot.id`, `rakazo.run.id`, and `rakazo.routine.id`
when the run belongs to a routine. Helper model calls inherit the same correlation.
Pi 0.87.1 exposes built-in telemetry through its newer harness; Rakazo’s legacy Agent
adapter maps its model and tool lifecycle through the same Pi telemetry contract.

Prompt, response, tool arguments and tool results are excluded by default.
`OTEL_CAPTURE_CONTENT=true` includes them: enable only with a trusted collector and
appropriate retention/access controls, since this content can contain secrets or personal
data. Unknown attributes and exception messages/stacks stay excluded. Export is batched,
best effort, and flushed when the worker shuts down; collector failures do not fail runs.

### Product analytics

Product analytics is off by default. To enable the PostHog adapter, set
`ANALYTICS_PROVIDER=posthog`, `ANALYTICS_KEY` to a project capture token, and
`ANALYTICS_HOST` to the HTTPS ingestion host (default `https://us.i.posthog.com`)
on API and worker. Also set `ANALYTICS_PSEUDONYM_SECRET` to a server-only random
value (`openssl rand -hex 32`), identical on API and worker. Retain it when rotating
the public capture token so user and event identities stay stable. Never send this
secret to the browser or collector. Set `ANALYTICS_PROVIDER=none` to disable it.
The public website uses its separate `PUBLIC_POSTHOG_KEY` configuration.

The backend sends account creation, session creation, fixed screen names, message
counts, and run starts/outcomes. Run events include the shared trigger enum;
analytics does not read or classify error text. User identifiers are pseudonymized
with the server-only secret. No names,
emails, prompts, responses, message text, DOM, URLs, search parameters, document
contents, request metadata, or raw errors are exported. There is no browser or
mobile analytics SDK, autocapture, session replay, or third-party script.
Web, Electron, and mobile send only fixed screen/surface enums to the authenticated
API; lifecycle events come from the shared backend. This works across clients
without giving a collector access to their content. Local and self-hosted
installations remain off until their backend is configured.

Delivery is best effort: memory is bounded, requests time out, and shutdown flushes
pending events. Analytics failure does not fail product operations. This is not a
durable audit trail, and events from before enablement are not backfilled.

### Logging

Backend services write structured logs to stdout. `LOG_LEVEL` is `debug`, `info`, `warn`, `error`,
or `off` (default `info`). Production defaults to `LOG_FORMAT=json`; development defaults to pretty
unless you set `json` or `pretty`.

Axiom is optional. Set both `AXIOM_TOKEN` and `AXIOM_DATASET` for ingest to one shared dataset.
Services set `service.name` (`rakazo-api`, `rakazo-worker`, `rakazo-sandbox-supervisor`,
`rakazo-updater`). A partial Axiom config logs a one-time warning and stays off. `AXIOM_EDGE` is a
regional hostname; `AXIOM_EDGE_URL` must be https and wins when both are set.

Computer usage is recorded at several boundaries:

- `run.computer`: one record per execution attempt, including runs that never request a computer
  (`reason=none`). `reason` is `tool`, `takeover`, or `script` otherwise; `tool` is an allowlisted
  built-in name and `trigger` identifies user, routine, or other run sources. Deduplicate `run.id`
  when counting runs, because a run can have several attempts.
- `computer.requested`: the first computer use in an attempt, with its reason, tool, and trigger.
- `computer.provisioned`: completed setup, with `operation=create`, `resume`, or `reuse` and
  `durationMs`. A setup request can reuse an already-running computer without spending a start.
- `sandbox.start`: Boat's actual `create`, `resume`, and `recover` requests, including starts during
  preparation or after the provider expires a computer. `outcome=accepted` means the provider
  accepted the request, not that all later setup succeeded. `rate_limited` and `failed` are
  separate outcomes. Count accepted creates/resumes for start usage; recoveries are shown separately
  because their quota treatment depends on the provider.
- `computer.suspended`: successful idle or active-limit suspension, with the active duration.

These records use fixed metadata, opaque correlation IDs, durations, and booleans. They do not add
prompts, responses, filenames, file contents, command arguments, or credentials. Request/job trace
fields link non-run starts back to the API route or background job that initiated them. Axiom is
an additional sink for the same logs; these events need no extra keys when ingest is configured.

For example, substitute your own dataset in these APL queries:

```apl
['YOUR_DATASET']
| where message == 'sandbox.start'
| summarize requests=count() by provider, operation, outcome
```

```apl
['YOUR_DATASET']
| where message == 'computer.requested'
| summarize requests=count() by trigger, reason, tool
```

```apl
['YOUR_DATASET']
| where message == 'run.computer'
| summarize attempts=count(), withoutComputer=countif(reason == 'none') by trigger
```

Track accepted starts per hour/day, rate-limit refusals, first-use tools, and the proportion of
attempts needing no computer before tuning `SANDBOX_IDLE_MS`. Increasing the idle window reduces
resumes between nearby uses but increases billed runtime; changing it does not remove unnecessary
starts caused by tools. Provider rolling-window limits remain the source of truth for quota.

Error reporting to Sentry or a Sentry-compatible collector such as GlitchTip is optional:

- `SENTRY_DSN` reports backend `error` logs, with the exception chain, `service`, and request or job
  ids as tags. Uncaught exceptions are reported before exit.
- `SENTRY_BROWSER_DSN` reports web app errors. The browser reads it from `/api/monitoring/config` at
  startup and posts reports to `/api/monitoring/tunnel`; the API forwards only envelopes addressed
  to that DSN. Use a separate project from `SENTRY_DSN`.
- `SENTRY_ENVIRONMENT` names the deployment. `SENTRY_RELEASE` defaults to the image's `GIT_SHA`.

Neither SDK sends cookies, headers, request bodies, user identity, console output, or log context.
When `ANALYTICS_PSEUDONYM_SECRET` is set, reports carry a keyed hash of the signed-in user's id so
the collector can count affected users; the raw id, email and IP address are never sent, and the
browser receives its hash from the API. Reporting is off without a DSN; an invalid DSN logs a
warning and stays off.

Compose passes these into the API, worker, supervisor, and updater. Computer containers and updater
child commands do not receive them.

Optional:

```env
SIGNUPS_ENABLED=true
SIGNUP_ALLOWLIST=you@example.com,@company.com
SANDBOX_PROVIDER=docker   # or none, e2b, daytona, createos, boat. Keep fake only for pnpm test.
AGENT_RUNTIME=pi          # Keep scripted only for pnpm test.
WAKEUP_DRIVER=graphile
SANDBOX_IDLE_MS=600000    # pause or stop after 10 minutes idle; 0 disables idle sleep
# Set 0 when self-hosting with Docker, where an idle computer costs nothing, to keep long-running apps and sessions up.
# E2B, CreateOS and Boat still apply their own timeouts.
COMPUTER_MAX_ACTIVE_MS=7200000 # uptime cap for providers that bill while running; minimum 60000; 0 disables
SANDBOX_COMMAND_TIMEOUT_MS=300000 # stop a shell command after 5 minutes
MAX_TOOL_CALLS_PER_TURN=  # optional Pi turn tool-call fuse; unset/0 = unlimited
RAKAZO_MESSAGE_USER_MAX_CHARS=500 # message_user length cap; narration stays at 500
BOT_MESSAGE_MAX_HOPS=6    # bot-to-bot messages one chain may carry before the next is refused
E2B_API_KEY=              # when SANDBOX_PROVIDER=e2b
DAYTONA_API_KEY=          # when SANDBOX_PROVIDER=daytona
CREATEOS_SANDBOX_API_KEY= # when SANDBOX_PROVIDER=createos
BOAT_API_KEY=             # when SANDBOX_PROVIDER=boat
```

To use an operator-controlled OpenAI-compatible server such as Ollama, LM Studio, llama.cpp, or
MLX, list its model IDs and an endpoint that both the API and worker processes can reach:

```env
RAKAZO_LOCAL_MODELS=qwen3:4b,llama3.1:8b,qwen3-vl
RAKAZO_LOCAL_MODELS_URL=http://127.0.0.1:11434/v1
RAKAZO_LOCAL_CONTEXT_WINDOW=32768
RAKAZO_LOCAL_MAX_TOKENS=4096
# Optional: model ids on this endpoint that accept images (screenshot computer tools).
RAKAZO_LOCAL_VISION_MODELS=qwen3-vl
```

The loopback default is suitable when running Rakazo from a source checkout. From containers,
prefer a stable LAN RFC1918 address (not Compose service DNS alone). On Docker Desktop,
`host.docker.internal` also works.
On Docker Desktop, a bot computer shell can often reach services bound to host `127.0.0.1`
through that same hostname. Do not run sensitive unauthenticated services on loopback while
bots run, or firewall / block that path. Linux does not get `host.docker.internal` the same
way by default.
Only configure an endpoint you control: prompts, attachments, and tool results sent to that model
leave Rakazo through this URL. Leave `RAKAZO_LOCAL_MODELS` blank to disable the provider.

Each user can also connect their own OpenAI-compatible endpoint from **Connect a model** /
**Settings → Models** on web and mobile. Choose **OpenAI-compatible**, enter the server base URL
(for example `http://127.0.0.1:8000/v1`), the exact model id, and an optional API key.
Public hosts and ordinary hostnames need `RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC=1` and HTTPS.
Literal private IP, loopback, and `host.docker.internal` targets do not, but only the deployment
owner can use them, checked on save, on model discovery, and on every run. Set
`MCP_ALLOW_PRIVATE_ENDPOINT=true` on the API and worker to allow them for every user.
For a self-hosted endpoint whose hostname resolves to private IPs, set
`RAKAZO_OPENAI_COMPAT_PRIVATE_HOSTS=models.example.test,other.example.test` in the deployment
environment for both API and worker, then recreate those containers. Entries are exact hostnames
(case-insensitive, optional trailing dot), not URLs, suffixes, or wildcards. These hosts do not
need `RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC`; every DNS answer must be private, and metadata and
link-local destinations remain blocked. This applies to discovery and model requests.
HTTPS still validates the hostname's certificate. Like private IP endpoints, trusted hostnames
also permit HTTP with API keys; use HTTPS unless the network is trusted. Only allow hosts you
control: like other private endpoints, allowlisted hosts are limited to the deployment owner
unless `MCP_ALLOW_PRIVATE_ENDPOINT=true`.
If that endpoint's model
accepts images, enable **Supports images** under **Advanced** when connecting so attachments and
screenshot computer tools stay available. Existing connections default to disabled. For centrally
managed endpoints, the deployment-wide fallback remains
`RAKAZO_OPENAI_COMPATIBLE_VISION_MODELS=gpt4o-vision,llava`.

### Client updates

Every web build is named by the UTC time it was built (`YYYYMMDDHHMMSS`). The web app sends its
build on each `/rpc` request in `x-rakazo-client-build` (`web/20261022093015`; the mobile app sends
`mobile/` and the time its JavaScript bundle was built), and the API answers with the web build in
its own image in `x-rakazo-build`. An open tab that sees a newer build reloads at a safe moment:
while hidden, on its next navigation, or after a few idle minutes with nothing typed.

To retire old clients immediately, set `RAKAZO_MIN_CLIENT_BUILD` on the API, for example
`web=20261022093015` or `web=20261022093015,mobile=20261001000000`, and restart it. Older clients
get HTTP 426 `CLIENT_UPDATE_REQUIRED`: the web app reloads, and the mobile app offers its update.
Read the current build from the `x-rakazo-build` header of any `/rpc` response. Requests that name
no build, such as webhooks and API tools, are never refused. A malformed value stops the API from
starting rather than being ignored.

### Client addresses

Sessions, logs, and security events carry the caller's address. The API believes a forwarded
header only when the TCP peer is in `TRUSTED_PROXIES` (IPs, CIDR ranges, or hostnames such as a
Compose service name). It reads that header (`CLIENT_IP_HEADER`, default `x-forwarded-for`) right
to left past trusted hops. Anyone else is the TCP peer, so a client cannot choose its own address.
Unset, `TRUSTED_PROXIES` in a container is `local-networks`: loopback and every network the API
has an interface on. Outside a container it is loopback only, since the host's networks can hold
direct clients. `none` trusts no proxy. In Compose those networks are the stack's own, which hold the web container and the network
gateway a reverse proxy on the Docker host connects from, so a host proxy that sets
`X-Forwarded-For` (Caddy does; nginx needs `proxy_set_header X-Forwarded-For
$proxy_add_x_forwarded_for`) is believed without configuration. Bot computers are never on those
networks, so they cannot choose an address. Production Compose sets `caddy` instead. For any
other layout, list every proxy between the internet and the API. Sign-in rate limits count per
client address, so a proxy that is not believed makes every user share one limit.

Caddy resolves the client first. `Caddyfile.prod` takes the TCP peer and overwrites
`X-Forwarded-For` with it. Behind a CDN, Caddy has to trust the CDN's ranges and read its client
header: `Caddyfile.cloudflare.example` does this with Cloudflare's ranges and `CF-Connecting-IP`.
For another CDN, copy that file and change the ranges and the header. If you copied the Cloudflare
example before this change, copy it again.

### Content-Security-Policy

The web server sends a strict Content-Security-Policy: scripts and connections are limited to the
app's own origin. When a CDN in front of the app injects a script, such as an analytics beacon, the
browser blocks it until you add its origins. `RAKAZO_CSP_SCRIPT_SRC` extends `script-src` and
`RAKAZO_CSP_CONNECT_SRC` extends `connect-src`. Each takes space-separated `https://` origins, with
an optional port and leading `*.` wildcard (`https://*.example.com`). Keywords such as
`'unsafe-inline'`, bare schemes, `*`, `http://` origins and paths are rejected, and the web server
refuses to start until the value is fixed. Restart the web service after changing either one.

For example, Cloudflare Web Analytics loads its script from one host and reports to another:

```bash
RAKAZO_CSP_SCRIPT_SRC=https://static.cloudflareinsights.com
RAKAZO_CSP_CONNECT_SRC=https://cloudflareinsights.com
```

Add only origins you trust: a script these settings allow runs with the signed-in user's access.

Browsers report what the policy blocks to `/api/csp-report`. The API writes one `csp.violation`
warning per violation, with the directive, the blocked origin and the page path, so search your logs
for it to find the origins to add.

### Security events

The API and worker append a row to `security_events` and write a `security.event` log line for:

- sign-up, sign-in, sign-out, and failed sign-in or sign-up
- session revocation, password and passkey changes, and account deletion
- model, MCP, connector, voice, memory, and secret credentials created, changed, or removed
- deployment settings changes, approval decisions, and approval policy changes
- refused private or internal destinations (`egress.refused`) and auth rate-limit hits

Each event has the user, space, client address, user agent, time, and a few identifiers. Events
never include message content, secrets, or tokens. Rows older than `SECURITY_EVENT_RETENTION_DAYS`
(default 90) are deleted, and Postgres rejects updates to the rows that remain.

The deployment owner can read recent events through the `security.events` RPC, filtered by `type`,
`ip`, or `userId`, and paged with `cursor`. You can also query Postgres:

```bash
docker compose --env-file .env -f infra/compose/docker-compose.prod.yml exec postgres \
  psql -U rakazo -d rakazo -c 'SELECT "createdAt", type, ip, "userId", "userAgent", metadata
  FROM security_events ORDER BY "createdAt" DESC LIMIT 50'
```

Caddy writes a JSON access-log line for each request to stdout. The lines exclude
`Authorization`, `Cookie`, and `Set-Cookie`, and URL tokens are replaced with `REDACTED`. Docker
rotates container logs and drops them when it recreates a container. To keep Caddy's lines, ship
container stdout to your log sink with a collector. Security events reach the sink through the
API's own log shipping, and Postgres keeps them too.

### What to alert on

The queries below are pseudo-SQL over the JSON log lines, so translate them to your log sink. Field
names are the literal keys in each line: `message`, `security.event.type`, `client.ip`,
`user_agent.original`, `user.id`, and the `security.event.metadata` object. Tune the thresholds to
your traffic.

Sign-up bursts from one address:

```sql
SELECT "client.ip", count(*) FROM logs
WHERE message = 'security.event' AND "security.event.type" = 'auth.sign_up'
GROUP BY "client.ip", bucket(1 hour) HAVING count(*) > 3
```

Password guessing, from one address and across many:

```sql
SELECT "client.ip", count(*) FROM logs
WHERE "security.event.type" IN ('auth.sign_in.failed', 'rate_limit.hit')
GROUP BY "client.ip", bucket(15 minutes) HAVING count(*) > 10;

SELECT count(DISTINCT "client.ip") FROM logs
WHERE "security.event.type" = 'auth.sign_in.failed'
GROUP BY bucket(15 minutes) HAVING count(*) > 50
```

Probes of internal addresses. Any hit deserves a look:

```sql
SELECT "user.id", "security.event.metadata.host", "security.event.metadata.reason", count(*)
FROM logs WHERE "security.event.type" = 'egress.refused'
GROUP BY 1, 2, 3
```

Scripted clients on account routes:

```sql
SELECT "client.ip", "user_agent.original", count(*) FROM logs
WHERE "security.event.type" LIKE 'auth.%'
  AND ("user_agent.original" IS NULL
    OR lower("user_agent.original") SIMILAR TO '%(curl|wget|python|go-http-client|headless|okhttp|java/)%')
GROUP BY 1, 2
```

Credential and settings changes from an address that user has not signed in from:

```sql
SELECT * FROM logs c
WHERE (c."security.event.type" LIKE 'credential.%'
    OR c."security.event.type" = 'deployment.settings.changed')
  AND NOT EXISTS (SELECT 1 FROM logs s WHERE s."security.event.type" = 'auth.sign_in'
    AND s."user.id" = c."user.id" AND s."client.ip" = c."client.ip")
```

### Prompt cache capabilities

The model connection API accepts `cacheCapabilities`, including `scope`,
`retentionMs`, `minimumTokens`, and `retentionMode`. Declare a positive
`retentionMs` only when the endpoint supports prefix reuse for that window.
For these connections with usable history-retrieval tools, the runtime
automatically uses cache-aware context:
recent history remains bounded on a cold request, and subsequent requests keep
that selected prefix while it is likely warm and fits the context budget.
Connections with unknown retention or `retentionMode: "none"` retain the default
retrieval policy. An explicit executor context strategy still takes precedence.
Callers without usable history-retrieval tools keep fitting original history
under the model's context budget instead of replacing it with snapshots.

Cache warmth is advisory. Changing instructions or tools, context pressure,
worker eviction, or a process restart can require fresh prompt processing.
These settings do not create backend KV snapshots or keep a model loaded;
the inference server is responsible for retention and conversation switching.

### Web search and page reading

Builtin `web_search` and `web_fetch` use keyless HTTP search (DuckDuckGo HTML) and local
Readability extraction by default. To choose [Parallel Search MCP](https://docs.parallel.ai/integrations/mcp/search-mcp),
set `WEB_PROVIDER=parallel` in `.env` and restart both the API and worker. The same bot tools
then return search excerpts and extracted page markdown through HTTPS MCP at
`https://search.parallel.ai/mcp`. Search uses Fast mode without an account or API key.

This option sends search queries and requested page URLs to Parallel, which retrieves pages
on its servers. Conversation accounting uses an HMAC of internal IDs keyed by
`ENCRYPTION_KEY` (shared by the API and worker), so deployments with distinct secrets send
distinct session IDs. Rotating that secret resets the session IDs; the existing development-only
encryption-key fallback also applies here. Anonymous access has service limits; rate-limit and provider errors are returned
to the bot without switching providers. Per-bot disabled web tools remain disabled. Set
`WEB_PROVIDER=keyless-http` (or remove the setting) to return to the default.

To choose [Keenable](https://docs.keenable.ai) instead, set `WEB_PROVIDER=keenable` and restart
both the API and worker. The same bot tools then return search snippets and extracted page
markdown through HTTPS MCP at `https://api.keenable.ai/mcp`, without an account or API key. This
option sends search queries and requested page URLs to Keenable, which retrieves pages on its
servers. Anonymous access is rate limited per IP address; set `KEENABLE_API_KEY` on the API and
worker to send a key and lift those limits. Errors, per-bot disabled tools and the way back to
the default work as described for Parallel.

### Self-hosted memory

Supermemory and Honcho can run on your own network. In **Settings → Memory**, choose **Local**
and enter the instance's base URL. Only the deployment owner can save a local endpoint. It must
be loopback or resolve to private addresses (a Compose service name, an RFC1918 or unique-local
address, or a `.internal` name such as Railway's private network); Rakazo pins the resolved
address for every request. Space members use the saved connection without seeing its key.

For [Honcho](https://github.com/plastic-labs/honcho), enable `AUTH_USE_AUTH` on the Honcho
server and use an admin JWT from its `scripts/generate_jwt.py --admin` as the key, so each Space
gets its own workspace. A workspace-scoped JWT works when you enter that workspace. Honcho needs
its own PostgreSQL with pgvector, an LLM provider, and an embedding provider; set
`EMBEDDING_VECTOR_DIMENSIONS` before its first start. Rakazo stores only explicitly saved facts
in Honcho; conversation summaries stay in Rakazo.

Remote MCP servers and installed API / GraphQL connectors default to public HTTPS. The deployment
owner can attach one on localhost, the same LAN, or a Docker network. Set
`MCP_ALLOW_PRIVATE_ENDPOINT=true` on the API and worker to allow these for every user. Cloud
metadata addresses stay blocked. Leave the flag unset on public installs.

Remote MCP servers that use OAuth normally register Rakazo with their provider on the first
**Connect OAuth**. Some providers only accept a client you create in their console. For those,
enter the client ID (and secret, for a confidential client) under **Advanced** when adding the
server, and add the **Redirect URI** shown there (`<your web origin>/mcp/oauth/callback`) to the
client's allowed redirect URIs. The client is stored encrypted with the server's other
credentials and survives **Disconnect**; switching to a different client drops the current grant.
On first use the client is bound to the authorization server the MCP server pointed to, and Rakazo
refuses to send it anywhere else afterwards. Replacing the client clears the binding.

Stdio MCP servers can use OAuth too. They do not authorize themselves (the MCP spec has them
read credentials from the environment), so Rakazo runs the flow for them. They are off unless
the API and worker have `MCP_STDIO_ENABLED=true` and the command is listed in
`MCP_STDIO_ALLOWED_COMMANDS`. When adding the server, enter the OAuth client, its
**Authorization server** (the issuer, for example `https://accounts.google.com`) and the
**Scopes**, then click **Connect OAuth** as for a remote server. Some providers issue a refresh
token only when asked through extra parameters: for Google, set **Authorization parameters** to
`access_type=offline&prompt=consent`. Pass the grant to the process
through its environment variables:

- A value can reference `{{oauth.access_token}}`, `{{oauth.refresh_token}}`,
  `{{oauth.client_id}}`, `{{oauth.client_secret}}`, `{{oauth.expires_at}}` (epoch milliseconds),
  `{{oauth.scope}}` or `{{oauth.token_type}}`, alone or inside other text.
- A variable can be a **File** instead: its template (often JSON, with the same references) is
  written to a private temporary directory when the process starts, and the variable receives
  the file's path. Use this for packages that read a credentials or token file path.

Rakazo refreshes the grant and restarts the process shortly before an access token it passed
expires, so a long-running process never keeps a dead token. A process that only receives the
refresh token refreshes on its own. Temporary files are removed when the process stops.

A server launched as `npx [-y] <package>[@version]` (or `npx -p <package> <bin>`) is not
downloaded on every start. Rakazo installs the package once with `npm install` into
`MCP_PACKAGES_DIR` (default `DATA_DIR/mcp-packages`, shared by the API and worker), then runs
its bin directly; `npx` must still be in `MCP_STDIO_ALLOWED_COMMANDS`. The install has its own
timeout, `MCP_STDIO_INSTALL_TIMEOUT_MS` (default 180000), separate from the handshake timeout
`MCP_STDIO_STARTUP_TIMEOUT_MS` (default 30000). Pin a version so every start runs the same
code; npm settings such as `NPM_CONFIG_REGISTRY` can be set in the server's environment
variables. Local paths, git and tarball URLs, and unknown `npx` flags fall back to running the
command as configured. Each server runs as one process per user in each of the API and worker,
shared by that user's bots, and stops after `MCP_STDIO_IDLE_MS` (default 900000, 15 minutes)
without use. When a server fails to start, the reason (including the end of its stderr, with
credentials redacted) appears on the server in **Settings**, and its bots are told it is
unavailable instead of silently losing its tools.

A run never waits long on one server. It gives each server `MCP_DISCOVERY_TIMEOUT_MS` (default
20000) to list its tools, then goes on without it; a package still installing finishes in the
background and its tools appear on a later turn. After a failure, runs skip that server for 30
seconds, doubling up to 5 minutes while it keeps failing. A successful **Test connection** or
discovery, or a change to the server's settings, ends the wait at once.

For servers that accept standard `reasoning_effort`, enable **Supports thinking** under
**Advanced** when connecting. The setting is saved on the connection (no env var or restart).
Existing connections default to disabled. Reconnect former Qwen-list or deployment-local models
via **Settings → Models** and turn it on; the old environment list is no longer read.

Enabled connections default to medium thinking. Web and desktop expose **Thinking** in a bot's
advanced settings; mobile inherits the same backend policy. Rakazo sends standard
`reasoning_effort` (`minimal`, `low`, `medium`, `high`, or `none` when off); the server owns
model-specific translation. Leave **Supports thinking** off when the server lacks standard effort
support. Existing token limits still apply; effort is not a separate reasoning-token budget.

Do not commit `.env`. Never put `COMPOSIO_API_KEY`, OpenRouter keys, or provider tokens in git, logs, or chat.

Optional messaging platforms (iMessage, Slack, WhatsApp, Telegram, Feishu/Lark) mount when their env credentials are set — see `.env.example`. Point a Feishu/Lark bot event subscription at `/api/v1/messaging/webhook/lark` (webhook/HTTP inbound only; do not enable long connection). Groups stay iMessage-only. Telegram can run several bots side by side (`TELEGRAM_BOT_TOKEN_<NAME>` plus `TELEGRAM_WEBHOOK_SECRET_TOKEN_<NAME>`), for example one per space, so the same person can chat with a different Rakazo bot through each.

### Settings with names you choose

The Compose files pass the API and worker only the settings each one reads, listed by name, rather than the whole `.env`. A setting whose name you choose, such as `TELEGRAM_BOT_TOKEN_<NAME>`, therefore needs its own line: add it under `api` and `worker` `environment` in an override file layered after the base file (and in `RAKAZO_COMPOSE_FILE` when the updater is enabled), with no value so Compose fills it from `.env`. `install-images.sh` names any `.env` setting that no container receives.

```yaml
# docker-compose.override.yml
services:
  api:
    environment:
      TELEGRAM_BOT_TOKEN_SUPPORT:
      TELEGRAM_WEBHOOK_SECRET_TOKEN_SUPPORT:
  worker:
    environment:
      TELEGRAM_BOT_TOKEN_SUPPORT:
      TELEGRAM_WEBHOOK_SECRET_TOKEN_SUPPORT:
```

`install-images.sh` layers a `docker-compose.override.yml` next to it automatically. In your own
commands, add `-f docker-compose.override.yml` after the base file.

## Choosing a computer provider

The Electron desktop app is a client of the same API. Docker remains the default. For an app-managed local instance, the deployment owner can choose **Use this Mac** (macOS) or **Use this computer** (Windows/Linux). After native confirmation, an authenticated bridge sends commands from the Docker backend to Electron, where they run under your OS account. **Computer Access…** in the app menu changes the choice; **Revoke Local Computer Access** immediately disconnects active operations and revokes the saved permission. Local execution requires the desktop app to remain running. Connecting to an existing remote instance does not grant it access to your computer. Browser and mobile clients use the deployment’s configured computer; they do not expose their own host. `SANDBOX_PROVIDER=desktop` is a separate, development-only configuration for backends running directly on the intended host.

Native file reads and workspace exports are limited to 8 MiB per file. A larger workspace file fails the checkpoint and preserves the previous saved workspace; local files remain on the computer. Writes are bounded by the 12 MiB encoded request limit.

- **Published images** (`docker-compose.images.yml`) default to `SANDBOX_PROVIDER=docker` with a
  local supervisor and published `ghcr.io/elie222/rakazo/computer` image. No E2B account required.
  Optional: set `e2b`, `daytona`, `createos`, or `boat` plus the matching API key for remote computers.
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

For provider configuration and health checks, see the [provider setup guide](./self-host-sandbox-providers.md).

## Content encryption

Rakazo encrypts chat messages, thread events, compacted history summaries, memory documents and
their revisions, and uploaded or generated files before they reach PostgreSQL or `DATA_DIR`.
Names, ids, timestamps and other metadata stay readable. Credentials are always encrypted,
whatever this setting says. Details and the threat model are in
[content encryption](./content-encryption.md).

**The key.** Content is encrypted under keys derived from `ENCRYPTION_KEY` (and
`ENCRYPTION_MASTER_KEYS`, if set). Without them, a backup of the database and `DATA_DIR` cannot
be read, by you or by anyone else. `install-images.sh` says so once, when it generates the key:

```text
Back up ENCRYPTION_KEY from /path/to/rakazo/.env. Encrypted content cannot be recovered without it.
```

It never prints the key. Store a copy somewhere other than the server and its backups.

**The switch.** `CONTENT_ENCRYPTION=on|off` in `.env`:

| Install | Unset means |
| --- | --- |
| Compose files, published images, Railway | `on` |
| Desktop app, **This computer** | `off` (the computer's disk encryption covers it) |
| Source checkout with `NODE_ENV=development` or `RAKAZO_ALLOW_DEV_SECRETS=1` | `off` |

With `off`, new content and files are stored readable, so you can query your own database
directly and a lost key cannot lose them. Content encrypted earlier still reads with the key, so
switching off never makes data unreadable. To convert it too, run `content-encryption decrypt`.
Any other value stops the API and worker at startup.

To switch on later, set `CONTENT_ENCRYPTION=on`, restart, then encrypt what was stored while
it was off. From the published-images folder (other stacks use their own Compose file):

```bash
docker compose -f docker-compose.images.yml exec api pnpm --filter @rakazo/api content-encryption migrate
docker compose -f docker-compose.images.yml exec api pnpm --filter @rakazo/api content-encryption status
```

Search works in both modes and while rows are mixed.

**Reading your data.** `content-encryption export` writes decrypted threads, messages, memory
documents and revisions as JSON lines. It reads the whole database by default; narrow it with
`--space <id>`, `--thread <id>` or `--bot <id>`. It only reads.

```bash
docker compose -f docker-compose.images.yml exec -T api \
  pnpm -s --filter @rakazo/api content-encryption export --bot <bot id> > rakazo-export.jsonl
```

The export is plaintext: store it like the database itself. Files are not included; use
`content-encryption decrypt` to make them readable on disk.

## Backup

```bash
./scripts/backup.sh
```

This dumps Postgres (`pg_dump`) and archives `data/` into `backups/<stamp>/`. A missing
`data/` produces an empty archive; database or archive errors fail the backup. Discard the
output directory of any failed run.

## Public single-VM deployment

`infra/compose/docker-compose.prod.yml` runs the hosted product with Postgres, the API, worker, web app,
and automatic HTTPS through Caddy. It uses E2B for bot computers, so the VM never exposes a Docker
supervisor or browser containers — `infra/compose/docker-compose.prod.docker.yml` is the opt-in
overlay that runs local Docker computers on the same stack (see below). The root-equivalent updater
sidecar is an explicit opt-in profile.

Before deploying to a new Ubuntu host, create and verify a key-only `deploy` account, then apply the
idempotent host-hardening baseline. It disables SSH passwords and root login, rate-limits SSH, allows
only SSH/HTTP/HTTPS through UFW, enables fail2ban, unattended security updates, AppArmor, audit rules,
and conservative kernel/network protections. Keep the provider console open until a fresh SSH login
succeeds after the script reloads SSH.

```bash
sudo --preserve-env=SSH_CONNECTION DEPLOY_USER=deploy bash infra/compose/harden-host.sh
```

The production host also uses `infra/compose/docker-daemon.json` to enable live restore, bounded local
container logs, default no-new-privileges, and the kernel NAT path instead of Docker's userland proxy.

1. Point an `A`/`AAAA` record such as `app.example.com` at the VM and allow inbound TCP 80/443 and
   UDP 443. If you use Cloudflare, enable the proxy with **Full (strict)** TLS and copy
   `Caddyfile.cloudflare.example` to an operator-controlled path outside the public checkout. Set
   `CADDYFILE_PATH` to that absolute path. The example drops application requests that do not come
   from Cloudflare's [published IP ranges](https://www.cloudflare.com/ips/); reconcile those ranges
   whenever Cloudflare publishes a change. A Cloudflare Tunnel can replace the public web listeners.
2. Clone the repository on the VM and create a root `.env` with production-only values. At minimum set
   `POSTGRES_PASSWORD`, `BETTER_AUTH_SECRET`, `ENCRYPTION_KEY`, `SCREEN_PROXY_SECRET`,
   `OPENROUTER_API_KEY`, the API key for your selected sandbox provider,
   `RAKAZO_HOST`, and the three public origins. Set `RAKAZO_DEPLOY_DIR` when the checkout is not at
   the supported Linux default, `/srv/rakazo`. Use URL-safe random values for database credentials.
   If you enable the `updater` profile, also set a dedicated `RAKAZO_UPDATER_TOKEN` (at least 32
   characters) that differs from `BETTER_AUTH_SECRET`, `SANDBOX_SUPERVISOR_TOKEN`, and
   `SCREEN_PROXY_SECRET`.
3. Keep registration allowlisted while the service is private:

```env
NODE_ENV=production
RAKAZO_HOST=app.example.com
# Optional operator-owned override, for example the Cloudflare allowlist file:
# CADDYFILE_PATH=/etc/rakazo/Caddyfile.prod
BETTER_AUTH_URL=https://app.example.com
WEB_ORIGIN=https://app.example.com
API_URL=https://app.example.com
SIGNUPS_ENABLED=true
SIGNUP_ALLOWLIST=owner@example.com,reviewer@example.com
# e2b, daytona, or boat
SANDBOX_PROVIDER=e2b
AGENT_RUNTIME=pi
WAKEUP_DRIVER=graphile
DATA_DIR=/data
# Absolute path of this checkout as the Docker daemon sees it. /srv/rakazo is the Linux default;
# set this explicitly for every other layout. See "The deploy directory must be one path" below.
RAKAZO_DEPLOY_DIR=/srv/rakazo
RAKAZO_IMAGE_TAG=local
# Optional: required only with `--profile updater`.
# RAKAZO_UPDATER_TOKEN=replace-with-32-plus-character-updater-token
```

4. Build the images from your checkout and start the stack, then verify its public health endpoint:

```bash
docker compose --env-file .env -f infra/compose/docker-compose.prod.yml \
  build --build-arg GIT_SHA=$(git rev-parse HEAD)
docker compose --env-file .env -f infra/compose/docker-compose.prod.yml \
  up -d --wait --pull never
curl --fail https://app.example.com/health
```

**Build, do not pull, for a first deployment.** `RAKAZO_IMAGE_TAG` ships as `local`, a tag no
registry serves, so the commands above build `api`, `worker`, and `web` from the checkout you just
cloned. The opt-in command under [Updater sidecar](#updater-sidecar) builds `updater` when needed.

The public `/health` only reports liveness. Runtime, sandbox, and revision details stay on the API
port at `/internal/health`, which the edge does not route:

```bash
docker compose --env-file .env -f infra/compose/docker-compose.prod.yml exec api \
  node -e "fetch('http://127.0.0.1:3100/internal/health').then(r=>r.text()).then(console.log)"
```

Passing `GIT_SHA` is what makes `/internal/health` report a `"revision"`; a locally built image has no
other way to know its commit. Prebuilt images from the registry bake it in at publish time, so
switching to a release tag needs nothing more: the containers report the revision the image was built
from, not a `GIT_SHA` in `.env`.

Once a release has been published you can switch this host to prebuilt images by setting
`RAKAZO_IMAGE_TAG` to that release tag and running `pull` followed by `up -d --wait --pull never`.
See [Published images and tags](#published-images-and-tags) for the tag contract.

The root `.env` is excluded from both Git and the Docker build context. The database, application data,
and Caddy certificates live in named Docker volumes.

The production Compose file pins Postgres and Caddy to multi-architecture manifest digests, and the
published application/updater builds pin their base-image digests. Refresh those pins deliberately
when taking upstream security updates; changing only the visible major tag does not change the
content while a digest is present.

For the single-VM production layout, install `infra/compose/backup-prod.sh` as
`/usr/local/sbin/rakazo-backup` and enable the supplied `rakazo-backup.timer`. It creates a verified
Postgres custom-format dump plus an application-data archive under `/var/backups/rakazo`, with mode
`0600`. It keeps up to `RAKAZO_BACKUP_KEEP` verified snapshots (default `3`), bounded by
`RAKAZO_BACKUP_MAX_GB` (default `50` GiB), and reserves `RAKAZO_BACKUP_MIN_FREE_GB` (default `5`
GiB) of free disk space. Before starting, it removes abandoned partial snapshots and excess history,
then checks capacity by scaling only the previous appdata archive by appdata source growth,
plus the previous database dump size. Snapshots without source-size
metadata use the raw source size for their initial estimate. It preserves the newest
verified snapshot when capacity is insufficient, caps output file sizes, and removes a failed run's
partial snapshot. Local snapshots alone do not survive losing the host; encrypt them and copy them
off-site as described below.

#### Encrypted and off-site backups

Backups are encrypted with [age](https://age-encryption.org) to public recipients only, so the host
can write backups it cannot read. Generate the key pair on a machine you control, not on the server,
and keep the identity file (the private key) offline, ideally with a second recipient held by
another operator:

```bash
age-keygen -o rakazo-backup.key   # prints "Public key: age1..."
```

`harden-host.sh` installs `age`; on other hosts run `apt-get install age`. Then set the public keys in
`/etc/rakazo/backup.env`, separated by spaces, or point at a recipients file with one key per line:

```env
RAKAZO_BACKUP_AGE_RECIPIENTS=age1exampleprimaryrecipient age1examplerecoveryrecipient
# or: RAKAZO_BACKUP_AGE_RECIPIENTS_FILE=/etc/rakazo/backup-recipients.txt
```

With recipients set, each snapshot holds `rakazo.dump.age`, `appdata.tgz.age`, `SOURCE_SIZE_KB`,
and `SHA256SUMS`. `pg_dump` and `tar` stream straight into age, so plaintext never touches disk.
Verification needs no private key: `pg_restore --list` and `tar -t` read the same plaintext stream
while it is encrypted, each file must carry an age header, and the checksums cover the encrypted
files.

Without recipients the backup stays plaintext as before, logs a warning, and the host check alerts
that the latest backup is not encrypted. After the first encrypted backup, a run without recipients
fails instead of quietly writing plaintext. Set `RAKAZO_BACKUP_ALLOW_PLAINTEXT=1` only to accept
plaintext on purpose; it also silences the host-check alert.

For an off-site copy, install `rclone` and set `RAKAZO_BACKUP_OFFSITE_REMOTE` to any
[rclone remote](https://rclone.org/overview/) and path, such as an S3-compatible bucket or an SFTP
server. Configure the remote with rclone's own settings in the same file, for example:

```env
RAKAZO_BACKUP_OFFSITE_REMOTE=offsite:rakazo-backups
RAKAZO_BACKUP_OFFSITE_KEEP=14
RCLONE_CONFIG_OFFSITE_TYPE=s3
RCLONE_CONFIG_OFFSITE_PROVIDER=Other
RCLONE_CONFIG_OFFSITE_ENDPOINT=https://s3.example.com
RCLONE_CONFIG_OFFSITE_ACCESS_KEY_ID=replace-me
RCLONE_CONFIG_OFFSITE_SECRET_ACCESS_KEY=replace-me
```

After each verified local snapshot, the encrypted files are uploaded to `<remote>/<stamp>/`,
checked with `rclone check`, and only then given `SHA256SUMS`, which marks the copy complete. Off-site copies require encryption. The remote
keeps the newest `RAKAZO_BACKUP_OFFSITE_KEEP` complete snapshots (default `14`), independent of
`RAKAZO_BACKUP_KEEP`; only stamp-named directories are removed. Set it to `0` to leave deletion to
the bucket's lifecycle rules, so the credentials need list, read and write but no delete permission. A failed upload keeps the
local snapshot but fails the service, so the backup alert fires.

#### Restoring an encrypted backup

Run these where the identity file lives, never leaving it on the server. Fetch a snapshot with
`rclone copy offsite:rakazo-backups/<stamp> ./<stamp>` or `scp`, then run the drill, which checks the
checksums and decrypts each file into `pg_restore --list` and `tar -t` without writing plaintext
(it needs `age`, `pg_restore` of the server's major version or newer, and `tar`):

```bash
bash infra/compose/backup-drill.sh ./<stamp> rakazo-backup.key
```

To restore, stop the application services, then stream each file to the server:

```bash
COMPOSE="sudo docker compose --env-file .env -f infra/compose/docker-compose.prod.yml"
ssh deploy@app.example.com "cd /srv/rakazo && $COMPOSE stop api worker web"
age -d -i rakazo-backup.key <stamp>/rakazo.dump.age | ssh deploy@app.example.com \
  "cd /srv/rakazo && $COMPOSE exec -T postgres sh -c 'pg_restore --clean --if-exists --no-owner -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\"'"
age -d -i rakazo-backup.key <stamp>/appdata.tgz.age | ssh deploy@app.example.com \
  "sudo tar -xzf - --numeric-owner -C \"\$(sudo docker volume inspect -f '{{.Mountpoint}}' rakazo-prod_appdata)\""
ssh deploy@app.example.com "cd /srv/rakazo && $COMPOSE up -d --wait --pull never"
```

Replace `rakazo-prod_appdata` with the volume the api container mounts at `/data` if the stack uses another
project name. Plaintext snapshots restore the same way with `cat` in place of `age -d`.

The scheduled backup uses `/srv/rakazo` by default. For another deployment directory, set
`RAKAZO_DEPLOY_DIR=/absolute/path/to/checkout` in a root-owned `/etc/rakazo/backup.env`
(mode `0600`). The service reads this optional file on each run; the script uses the selected
checkout's `.env` and production Compose file. If the stack was started with a custom `-p`,
set the same `COMPOSE_PROJECT_NAME` in that file. Set the retention and space settings there too.
When updating an existing installation, reinstall the script and units, then run
`systemctl daemon-reload`; pulling the repository does not update `/usr/local/sbin` copies.

For a dedicated backup disk, mount it persistently and bind its `backups` directory onto
`/var/backups` in `/etc/fstab`. Add `x-systemd.requires-mounts-for=/mnt/your-backup-volume` to the bind
mount options. Set `RAKAZO_BACKUP_REQUIRE_VOLUME=1` and add a service drop-in containing
`RequiresMountsFor=/var/backups` and `AssertPathIsMountPoint=/var/backups` under `[Unit]`. The script
then refuses to fall back to root storage if the mount is missing or points at the root filesystem.

Monitoring is opt-in. Install `host-alert.py` as `/usr/local/sbin/rakazo-host-alert` and
`check-host.sh` as `/usr/local/sbin/rakazo-host-check`, then install the supplied host-check service
and timer and enable `rakazo-host-check.timer`. Checks run every five minutes and report low disk
space, failed backups, a verified backup older than 36 hours, or missing configured IPv4 SSH rules.
The dedicated-volume check is enabled only by `RAKAZO_BACKUP_REQUIRE_VOLUME=1` in `backup.env`.
Identical alerts are suppressed for a day; recovery sends a separate notification.

Alerts go to the system journal by default; no external service is required. For optional Slack
delivery, create a root-only `/etc/rakazo/alerts.json` containing
`{"slack_webhook":"https://hooks.slack.com/services/REPLACE/ME/SECRET"}`. Never commit this file.
To notify immediately on backup failure, also install `rakazo-backup-alert.service` and copy
`infra/systemd/rakazo-backup-alerts.conf.example` to
`/etc/systemd/system/rakazo-backup.service.d/alerts.conf`. Run `systemctl daemon-reload` after
installing units or drop-ins. The base backup service does not require the monitoring tools.

Host hardening preserves existing firewall rules and installs `firewall-change.sh` as
`/usr/local/sbin/rakazo-firewall-change`. For subsequent firewall edits, use
`sudo --preserve-env=SSH_CONNECTION /usr/local/sbin/rakazo-firewall-change apply COMMAND...`.
This requires `SSH_CONNECTION` to be preserved, saves both `/etc/ufw` and `/etc/default/ufw`,
and arms a three-minute rollback before running the command.
Open a **new SSH connection** and run the printed `confirm TOKEN` command; confirmation from the
original connection is rejected. An unconfirmed change restores the saved rules and default policies.
The guard does not protect arbitrary direct `ufw` commands or SSH daemon configuration changes.

To deploy from CI, install `infra/compose/deploy-launcher.sh` as `/usr/local/sbin/rakazo-deploy-main`
and give CI a key restricted to it in the deploy user's `authorized_keys`
(`restrict,command="/usr/local/sbin/rakazo-deploy-main" ssh-ed25519 …`). It builds `origin/main`,
starts each new API and web container beside the running one and stops the old one only once the
new one is healthy, so a deploy does not take the site offline, then waits for
`https://$RAKAZO_HOST/health` and rolls back on failure. Old and new API containers serve together
for a few seconds after migrations run, so a migration must keep working with the previous
release: add first, and drop or rename only in a later deploy. Build and
start are time-limited so a stuck build fails the deploy instead of holding its lock; a deploy that
finds the lock held exits non-zero. A deploy refuses to start with less than
`RAKAZO_DEPLOY_MIN_FREE_GB` (default `5`) free, and after a healthy rollout it removes untagged
images and trims the build cache to `RAKAZO_DEPLOY_BUILD_CACHE_GB` (8 GB by default), keeping the previous images tagged `rakazo-rollback`.
For a checkout outside `/srv/rakazo`, put `RAKAZO_DEPLOY_DIR=/absolute/path` (and any of these
settings) in a root-owned `/etc/rakazo/deploy.env` readable by the deploy user. The launcher runs
`infra/compose/deploy-main.sh` from `origin/main`, so deploy changes apply on the next deploy; only
a change to the launcher itself needs
`sudo install -m 0755 infra/compose/deploy-launcher.sh /usr/local/sbin/rakazo-deploy-main`.

### Docker computers on the production stack

Layer `infra/compose/docker-compose.prod.docker.yml` after the base file in every Compose
invocation to run bot computers as local Docker containers instead of a remote provider:

```bash
# Pull only the pull-only dependency images (postgres, caddy, busybox);
# --pull never fails when they are absent locally.
docker compose --env-file .env \
  -f infra/compose/docker-compose.prod.yml \
  -f infra/compose/docker-compose.prod.docker.yml \
  pull --ignore-buildable
docker compose --env-file .env \
  -f infra/compose/docker-compose.prod.yml \
  -f infra/compose/docker-compose.prod.docker.yml \
  up -d --build --wait --wait-timeout 300 --pull never
```

In this topology `api`, `worker`, `web`, `supervisor`, and `computer` always build
from the checkout — `pull --ignore-buildable` only covers dependencies that have no
`build` section. To deploy published app images instead of building, use the base
file without the overlay. If `docker compose up --help` lacks `--wait-timeout`
(older Compose), drop `--wait` and verify with `docker compose ... ps` instead;
`--wait` alone can hang on one-shot services.

The overlay adds the supervisor (app image, `user: root`, Docker socket), the one-shot `computer`
image build and `data-init` ownership fix, points the API and worker at `http://supervisor:7091`,
and makes `SANDBOX_PROVIDER=docker` the default. It needs a dedicated `SANDBOX_SUPERVISOR_TOKEN`
in `.env`; `RAKAZO_COMPUTER_*` and the `SANDBOX_*` limits apply as documented in `.env.example`.
Like the updater, the supervisor is root-equivalent on the host: it publishes no port, joins only
the internal `app` network, and Caddy has no route to it. Bot computers are sibling containers on
per-bot networks that only the supervisor and the `web` screen proxy join.

When the `updater` profile is enabled too, give the sidecar the same file list and recreate set so
updates do not leave the supervisor on the previous app image:

```env
RAKAZO_COMPOSE_FILE=infra/compose/docker-compose.prod.yml:infra/compose/docker-compose.prod.docker.yml
RAKAZO_UPDATE_SERVICES=supervisor
```

The updater pulls and recreates services but cannot rebuild the `computer` stub image
(`pull_policy: build` is not pullable). Rebuild it on the host when the computer image
should change — for example after updating the checkout:

```bash
docker compose --env-file .env \
  -f infra/compose/docker-compose.prod.yml \
  -f infra/compose/docker-compose.prod.docker.yml \
  build computer
```

## Restore

For backups created by `scripts/backup.sh`, use an empty `rakazo` database in the development
Compose stack, with application services stopped. The SQL import runs in one transaction and
stops on the first error, including conflicts with existing tables. Files are restored and
application services started only after the import succeeds. This script does not consume the
production snapshot's custom-format `rakazo.dump` or `appdata.tgz`.

```bash
./scripts/restore.sh backups/<stamp>
```

## Upgrade

A Compose deployment on a published release tag upgrades by moving that tag:

```bash
docker compose --env-file .env -f infra/compose/docker-compose.prod.yml pull api worker web
docker compose --env-file .env -f infra/compose/docker-compose.prod.yml \
  up -d --wait --pull never api worker web
```

A deployment on the default `local` tag has no registry to pull from, so it upgrades by rebuilding
the checkout instead:

```bash
git pull
GIT_SHA=$(git rev-parse HEAD) docker compose --env-file .env -f infra/compose/docker-compose.prod.yml \
  up -d --wait --pull never --build api worker web
```

`up --wait` does not report success until the new API is healthy and the worker and web containers
are running. The API container runs the migration step (`db:deploy`) before it starts serving, so migration
failure keeps health red. A failed CLI recreate does not auto-roll back; recover with the previous
`RAKAZO_IMAGE_TAG` (or rebuild `local`) and `up -d --wait --pull never`.

The updater sidecar has its own image and tag so an update never recreates the process performing
it. Move it deliberately by setting `RAKAZO_UPDATER_IMAGE_TAG` to the full `sha-<commit>` tag, then
running `docker compose … pull updater && docker compose … up -d --wait --pull never updater`.
Sidecar `/apply` and `/rollback` recover a failed recreate by redeploying the previously cached
image when possible; if that also fails, they report a possible mixed-version runtime.

Source checkouts (not Compose) still upgrade the old way: pull, rebuild with
`GIT_SHA=$(git rev-parse HEAD)`, run `pnpm db:migrate`, then restart API and worker.
Product contracts stay compatible across cloud and self-hosted.

### Upgrading to the separate app database login

Releases with [database roles](#database-roles) need `POSTGRES_APP_PASSWORD` in `.env`. The
desktop app, `install-images.sh`, the updater sidecar and `infra/compose/deploy-main.sh` add it
when it is missing.
Elsewhere, add it yourself (`openssl rand -hex 16`) before you pull, or Compose stops at config
validation with `Set POSTGRES_APP_PASSWORD in .env`. On first start, the API creates the
`rakazo_app` login, and the API and worker then connect as it. Nothing else changes, and the
upgrade does not rewrite any data.

If a feature misbehaves under row-level security, run `ALTER ROLE <login> BYPASSRLS;` on the login
in `DATABASE_URL` (`rakazo_app` in Compose) as a superuser (the Compose owner is one), then
restart the API and worker. Role attributes are not inherited, so granting it to `rakazo_app` does
nothing for a separate login. The app then runs as before, with a startup warning, and later
migrations leave that login alone. Undo it with
`NOBYPASSRLS` and another restart, then search the API and worker logs for
`violates row-level security` and `without a tenant or system context`. An older release ignores
the extra variable and connects as the owner, but releases from the same day also encrypt content
at rest: run `content-encryption decrypt` before rolling back past them
([content encryption](./content-encryption.md#rollout)), or older releases show ciphertext.

### Space privacy-boundary migration

Before upgrading across migration `20260830200000_space_scope_names_and_user_credentials`, check
that every existing model and voice credential still belongs to a member of its Space. This query
uses the pre-migration `workspaceId` column name and must return no rows:

```sql
SELECT 'model' AS credential_type, credential."id", credential."userId",
       credential."workspaceId" AS "spaceId"
FROM "user_model_credentials" AS credential
LEFT JOIN "space_members" AS membership
  ON membership."spaceId" = credential."workspaceId"
 AND membership."userId" = credential."userId"
WHERE membership."id" IS NULL
UNION ALL
SELECT 'voice', credential."id", credential."userId", credential."workspaceId"
FROM "user_voice_credentials" AS credential
LEFT JOIN "space_members" AS membership
  ON membership."spaceId" = credential."workspaceId"
 AND membership."userId" = credential."userId"
WHERE membership."id" IS NULL;
```

The migration renames columns used by the API and worker and is therefore a coordinated cutover,
not an online rolling migration. Stop the old API and worker, apply the migration, and start the new
versions together. Its lock waits are bounded so contention fails the migration instead of leaving
application traffic queued indefinitely.

### Published images and tags

`.github/workflows/publish-server-image.yml` publishes to `ghcr.io/<owner>/<repo>/…`, derived from
`${{ github.repository }}` rather than hardcoded, so a fork's CI fills the fork's own namespace. For
this repository that is:

| Image | Contents |
| --- | --- |
| `ghcr.io/elie222/rakazo/app` | api, worker, web, and sandbox supervisor — one image, multiple commands |
| `ghcr.io/elie222/rakazo/computer` | Linux desktop used as each bot computer |
| `ghcr.io/elie222/rakazo/updater` | the updater sidecar, plus the Docker CLI |

`infra/compose/docker-compose.images.yml` is the no-checkout path for those app and computer tags
plus Postgres. The supervisor runs from the app image on the internal network only (not a separate
published supervisor image, and no host port). Production Compose (`docker-compose.prod.yml`) can
also pull the same app tags once `RAKAZO_IMAGE_TAG` is set to a published value.

If you deploy from your own fork, set `RAKAZO_IMAGE` and `RAKAZO_UPDATER_IMAGE` to your namespace —
your CI cannot publish into someone else's.

| Tag | Published on | Moves? |
| --- | --- | --- |
| `local` | nothing — built locally by `up --build` | rebuilt in place |
| `local-<full-commit>` | nothing — built on the server by a fork update | never |
| `vX.Y.Z`, `vX.Y` | release tags | conventionally no / on patch releases |
| `latest` | stable `vX.Y.Z` tags only (not prereleases) | yes, to the newest stable release |
| `sha-<full-commit>` | every push and manual run | source-addressed; used by the updater sidecar |
| `edge` | pushes to main | yes, to the newest main build |

Every publish, including `edge` from main merges, is multi-arch (`amd64` + `arm64`): each
architecture builds natively on its own runner and one manifest is assembled per image. Until a
stable `vX.Y.Z` has been published, GHCR may only have `edge` and `sha-*` tags; do not pin
`latest` unless that tag exists in the registry.

Building the images yourself does not need QEMU. `docker compose up --build` builds for the host's
own architecture, and a fork publishing multi-arch images should do what `publish-server-image.yml`
does: build each architecture on a native runner (GitHub Actions provides `ubuntu-24.04-arm` for
public repositories) and merge the digests into one manifest. QEMU emulation
(`docker/setup-qemu-action`, `binfmt`) still works if you have no native arm64 machine, but it is
many times slower, hours rather than minutes for the `computer` image.

The updater resolves the newest stable `vX.Y.Z` source tag but deploys its `sha-<full-commit>` image,
not `latest` or a moving minor tag. A registry tag is not an OCI digest and GHCR package writers can
replace it, so the trust boundary remains this repository's publishing credentials. The workflow
reduces that boundary by using SHA-pinned actions, read-only pull-request jobs, digest-pinned base
images, SBOM/provenance output, and a GitHub build attestation. Operators who require registry-level
content addressing can pin `RAKAZO_IMAGE` outside the automatic updater to a verified digest.

Rollback never contacts the registry: it redeploys the previous tag from the local Docker cache,
so a later tag move cannot change rollback content. Do not prune the previous application image
until the next update has been accepted. If it is missing, rollback fails closed instead of pulling
new content under an old tag.

To populate the registry the first time, run the workflow manually (`workflow_dispatch`) or push a
`v*` tag. A manual run produces `sha-<full-commit>`; only a stable `vX.Y.Z` tag (no prerelease
suffix) produces `latest`, and any `v*` tag produces semver tags. The updater ignores prereleases
and refuses the official path until a stable `vX.Y.Z` exists.

### Updater sidecar

Compose production deployments offer an opt-in `updater` profile on a private `control` network.
Normal deployments do not start it or require its credential. To enable it, set a dedicated
`RAKAZO_UPDATER_TOKEN` and explicitly start the profile:

```bash
docker compose --env-file .env -f infra/compose/docker-compose.prod.yml \
  --profile updater up -d --build updater
```

It exposes `/health`, `/state`, `/plan`, `/apply`, and `/rollback` at `http://updater:7092` with
`RAKAZO_UPDATER_TOKEN`. Operator CLI upgrades above do not need it; the sidecar is for automated
apply/rollback over that private HTTP API.

The API cannot update itself — its image has no `.git`, and nothing inside the container would
restart it — so the work happens in a separate `updater` container that outlives the recreate:

- *Official repository:* resolves the newest stable release and its source commit with
  `git ls-remote --tags`, pins the corresponding full `sha-<commit>` image tag in `.env`, keeps the
  outgoing tag in `RAKAZO_IMAGE_TAG_PREVIOUS`, explicitly pulls the new image, then runs
  `up -d --wait --pull never`. No build runs on the server.
- *Fork (Advanced):* a fork has no published images, so the sidecar fast-forwards the checkout in
  `RAKAZO_DEPLOY_DIR` and runs `up -d --build`. This builds on the server and takes minutes rather
  than seconds. Point it only at a fork you control and have reviewed — the sidecar runs that
  Compose file through a root-equivalent Docker socket.

Updates and rollbacks run one at a time. A failed pull leaves running services alone; a failed recreate restores the previous environment
pin and attempts to redeploy the cached previous image. A failed fork build also restores the
pre-update branch and commit (including when checkout succeeded but merge did not) so a later
manual `--build` cannot deploy the rejected or unintended revision. Database migrations are not
reversed. The sidecar never recreates itself, never touches Postgres or Caddy, and never runs
migrations — that ordering belongs to the API start command.

Only `https://` and `ssh://` git remotes are accepted. Merges are fast-forward only. A dirty or
untracked source tree fails closed before anything runs (the application Dockerfile uses `COPY . .`).

### The deploy directory must be one path

`RAKAZO_DEPLOY_DIR` is bind-mounted into the updater at the same path it is read from
(`${RAKAZO_DEPLOY_DIR}:${RAKAZO_DEPLOY_DIR}`), and that is load-bearing rather than tidy. Production
Compose defaults both sides to `/srv/rakazo`; set the variable for any other layout. When the
updater runs `docker compose -p <project> --file $RAKAZO_DEPLOY_DIR/infra/compose/docker-compose.prod.yml up -d`,
the Compose CLI *inside* the container expands this file's relative bind mounts — `../../.env`,
`./Caddyfile.prod` — against that path and hands the results to the daemon. The daemon has to be
able to resolve the same strings, or it silently creates empty directories where your `.env` and
Caddyfile should be. Compose makes the effective `-p` value available for interpolation but does
not automatically put it in a container's environment, so the production file explicitly assigns
`COMPOSE_PROJECT_NAME` to the updater. A standalone sidecar can instead set
`RAKAZO_COMPOSE_PROJECT_NAME`; the final fallback is `rakazo-prod`. Without that propagation, a
stack started with `-p something-else` would be left alone while a second project with a new empty
Postgres volume came up beside it.

### Deployments that layer a Compose overlay

`RAKAZO_COMPOSE_FILE` takes a list, separated the way Compose's own `COMPOSE_FILE` is
(`:` by default, or whatever `COMPOSE_PATH_SEPARATOR` says). Each entry becomes its own `--file`,
in the order given, so the updater reconciles the same stack the operator runs by hand:

```
RAKAZO_COMPOSE_FILE=infra/compose/docker-compose.prod.yml:ops/compose/overlay.yml
```

Every entry is validated separately and must stay inside `RAKAZO_DEPLOY_DIR`.

If the overlay adds a service built from the application image, name it in
`RAKAZO_UPDATE_SERVICES` (comma separated) so it is pulled, recreated and rolled back with the
rest. Otherwise an update leaves that service running the previous code:

```
RAKAZO_UPDATE_SERVICES=supervisor
```

These names are appended to the built-in `api`, `worker`, `web`, never substituted for them, so no
value here can drop a core service from an update.

The value therefore has to be the path **the daemon** sees, which is not always the path your shell
sees:

- **Linux.** The daemon shares the host filesystem, so the checkout path is the answer:
  `/srv/rakazo` is the default and supported production layout. Set `RAKAZO_DEPLOY_DIR` explicitly
  when the checkout is elsewhere.
- **Docker Desktop (Windows/macOS).** The daemon runs in a VM that mounts your drive somewhere else.
  On Windows, `C:` appears at `/run/desktop/mnt/host/c`, so a checkout at `C:\Users\you\rakazo` is
  `RAKAZO_DEPLOY_DIR=/run/desktop/mnt/host/c/Users/you/rakazo`. Host Git may use `core.autocrlf=true`; the updater ignores CR-only diffs so that does not block `/apply`. Verify the mount before deploying:

```bash
docker compose --env-file .env -f infra/compose/docker-compose.prod.yml \
  --profile updater run --rm updater git -C "$RAKAZO_DEPLOY_DIR" log --oneline -1
```

  That must print your checkout's HEAD. The two tempting wrong answers both fail: a native Windows
  path is rejected by the daemon (`mount denied: … too many colons`, because the drive letter's
  colon collides with the bind-mount separator), and `/mnt/c/...` fails *silently* — the container
  starts, the mount is an empty directory, and the updater simply reports no checkout.

### The updater's privileges

The updater holds the Docker socket, which is root-equivalent on the host. It is scoped as narrowly
as that allows:

- No `ports`, so nothing is published on the host.
- Only on the dedicated `control` network shared with the API. Caddy is not attached, so the
  reverse proxy has no route to the updater.
- Every route except `/health` requires the shared bearer token, compared in constant time.
- The process environment carries only updater settings (`RAKAZO_UPDATER_TOKEN`, deploy path,
  image name, project name). Application secrets stay in the bind-mounted `.env` that Compose
  reads for interpolation; they are not loaded into this container.
- The Docker CLI lives only in the updater image. The api, worker, and web containers keep
  `cap_drop: ALL` and no socket.

Enabling the `updater` profile requires `RAKAZO_UPDATER_TOKEN` to be a dedicated random value (at
least 32 characters in production). It must differ from `BETTER_AUTH_SECRET`,
`SANDBOX_SUPERVISOR_TOKEN`, and `SCREEN_PROXY_SECRET`. Leave the profile disabled if you would
rather not grant the capability.

## Other deployment layouts

API and worker need always-on processes; serverless request handlers are not sufficient. Use a
Node.js version supported by the root `package.json`, Postgres 16 and a persistent `DATA_DIR` volume shared by API and worker, with encrypted off-host
backups. The current home store uses a local filesystem, so deployments on separate hosts need a
shared filesystem; an object-storage adapter is not available yet.

Use the same HTTPS origin for the web app, `/api`, and `/rpc`. Preserve the authenticated screen
proxy routes. Choose a [computer provider](#choosing-a-computer-provider) appropriate to the
service's trust boundary. `SIGNUPS_ENABLED` applies on the API's first start. A non-empty
`SIGNUP_ALLOWLIST` applies on every API start.
The optional marketing site in `apps/www` can be hosted separately.

## Image and video generation

Bot media tools are disabled by default. Configure the worker (and API for inline
execution) with a provider and its generic HTTP connection:

```dotenv
MEDIA_GENERATION_PROVIDER=fal
MEDIA_GENERATION_BASE_URL=https://queue.fal.run
MEDIA_GENERATION_API_KEY=replace-with-media-api-key
MEDIA_GENERATION_IMAGE_MODEL=fal-ai/flux/schnell
MEDIA_GENERATION_VIDEO_MODEL=fal-ai/wan/v2.2-a14b/text-to-video
```

`MEDIA_GENERATION_PROVIDER` accepts `disabled` (the default), `fal`, or `fake`
(for offline testing only). The base URL is optional and defaults to the URL above.
Only set the image/video model fields for capabilities you want enabled. Compatible
servers can use the same connection fields; models must support the corresponding
fal queue API and Flux/Wan input and output shapes. Credentials stay on the server. Set these in
your deployment secret configuration; never commit actual credentials.

Bots use `generate_image` to attach one PNG or `generate_video` to submit a
four-second MP4. The video tool returns a job ID and queued/running status; call it
again with `jobId` to check progress and attach the completed video. Saved jobs
can be polled after worker restarts by the same owner/bot/thread. The first version
requires polling through the bot; it does not automatically deliver jobs in the
background. Use the existing per-bot tool switches and action approval rules to
control access. Both tools require approval by default. Ticket board runs keep
these chat-only media tools unavailable so ticket work stays on the board.

Each run allows at most two submissions (including failures). Submissions are
never retried automatically: a lost response can mean the provider accepted and
charged for the request. Provider errors omit remote response bodies. Configure
account budgets and rate limits with your provider; the run cap is not a currency
budget. Provider 429 responses are returned without automatic retries. Outputs
must fit both the 10 MiB media ceiling and the configured attachment limit;
larger outputs are rejected.

Images use existing inline chat rendering. MP4 files can be previewed with native
video controls on web and Electron and opened/downloaded through the existing
native file flow on mobile. No new mobile player or settings screen is required.

## Connect mobile clients

The iOS and Android app can also point at a self-hosted origin at runtime. On the sign-in screen, tap **Use a custom server** and enter the same HTTPS origin as `WEB_ORIGIN` (for example `https://app.example.com`). Store builds still default to `EXPO_PUBLIC_API_URL`; the in-app setting is an override for people running their own API. Changing the server signs the device out of any previous session.

### Passkeys

Passkeys are on whenever `WEB_ORIGIN` is an HTTPS domain (or `localhost` in development); the
relying party is that origin's host, so existing passkeys keep working only while `WEB_ORIGIN`
stays on the same domain. They are off when password sign-in is disabled for SSO-only
deployments. On web, a browser offers them where it has a platform authenticator; the macOS
desktop app does not, so it hides them.

Native apps can use a domain's passkeys only when the domain vouches for them and the app was
built for that domain (the app's associated domain comes from `EXPO_PUBLIC_API_URL` at build
time). To let a build use this server's passkeys, set:

```bash
# iOS: <Apple Team ID>.<bundle id>, comma-separated. Served as /.well-known/apple-app-site-association.
PASSKEY_APPLE_APP_IDS=ABCDE12345.com.rakazo.app
# Android: SHA-256 fingerprints of the app signing certificates, comma-separated.
# Served as /.well-known/assetlinks.json and accepted as passkey origins.
PASSKEY_ANDROID_CERT_SHA256=AA:BB:...:FF
```

Until a platform's setting is set, the native app on that platform hides passkeys for this
server. Both files are served through the web origin, so a reverse proxy in front of the web container
must pass `/.well-known/` through to it.

## Upload size

`MAX_UPLOAD_SIZE_MB` sets the per-file chat attachment and computer file transfer limit
in MiB (1 MiB = 1,048,576 bytes). It defaults to `10` and must be a positive integer.
Set it in `.env` and restart the API, worker, and Docker supervisor (when used). Web, desktop, and mobile use the
limit advertised by the server. If a reverse proxy limits request bodies, allow
room for base64 encoding (about 4/3 of the file size) and the JSON envelope.
